<?php
/**
 * Plugin Name: Lattis Migrator
 * Description: Sends WordPress users, media files, and content to Lattis from WP-CLI.
 * Version: 0.3.0-alpha.1
 * License: MIT
 * License URI: https://opensource.org/license/mit
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!defined('WP_CLI') || !WP_CLI) {
    return;
}

final class Lattis_Migrator_Command {
    private const BATCH_SIZE = 10;
    private const MAX_MEDIA_BYTES = 12582912;
    private const MIME_TYPES = array('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf');

    /**
     * Migrate WordPress data to Lattis. Run users, then media, then content.
     *
     * ## OPTIONS
     *
     * <kind>
     * : users, media, or content.
     *
     * [--import-key=<key>]
     * : Stable key for this migration stream. Defaults to wp-cli-v1.
     *
     * [--user-auth=<mode>]
     * : User identity mode: verified-email (default) or password. Applies only to users.
     *
     * [--publish]
     * : Preserve public WordPress status. Without it, imported content stays draft.
     */
    public function migrate($args, $assoc_args) {
        $kind = $args[0] ?? '';
        if (!in_array($kind, array('users', 'media', 'content'), true)) {
            WP_CLI::error('Choose users, media, or content. Run them in that order.');
        }
        $key = $assoc_args['import-key'] ?? 'wp-cli-v1';
        if (!is_string($key) || !preg_match('/^[A-Za-z0-9_.-]{1,80}$/', $key)) {
            WP_CLI::error('Invalid import key.');
        }
        $user_auth = $assoc_args['user-auth'] ?? 'verified-email';
        if (!in_array($user_auth, array('verified-email', 'password'), true)) {
            WP_CLI::error('Choose --user-auth=verified-email or --user-auth=password.');
        }
        if ($kind !== 'users' && isset($assoc_args['user-auth'])) {
            WP_CLI::error('--user-auth applies only to user migration.');
        }
        $this->configuration();
        if ($kind === 'users') {
            $this->users($key, $user_auth);
        } elseif ($kind === 'media') {
            $this->media();
        } else {
            $this->content($key, isset($assoc_args['publish']));
        }
    }

    private function configuration() {
        $url = defined('LATTIS_MIGRATION_URL') ? LATTIS_MIGRATION_URL : getenv('LATTIS_MIGRATION_URL');
        $token = defined('LATTIS_MIGRATION_TOKEN') ? LATTIS_MIGRATION_TOKEN : getenv('LATTIS_MIGRATION_TOKEN');
        if (!is_string($url) || !is_string($token) || !preg_match('/^lattis_app_[A-Za-z0-9_-]+$/', $token)) {
            WP_CLI::error('Set LATTIS_MIGRATION_URL and LATTIS_MIGRATION_TOKEN in wp-config.php or the CLI environment.');
        }
        $parts = wp_parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            WP_CLI::error('LATTIS_MIGRATION_URL must be a clean HTTPS URL.');
        }
        $this->url = rtrim($url, '/');
        $this->token = $token;
        $this->site = home_url('/');
        if (strlen($this->site) > 191) {
            WP_CLI::error('WordPress site URL exceeds the Lattis source identifier limit.');
        }
    }

    private $url;
    private $token;
    private $site;

    private function request($method, $path, $data = null) {
        $args = array(
            'headers' => array('Authorization' => 'Bearer ' . $this->token, 'Accept' => 'application/json'),
            'timeout' => 60,
            'redirection' => 0,
            'sslverify' => true,
        );
        if ($method === 'POST') {
            $body = wp_json_encode($data);
            if ($body === false) {
                WP_CLI::error('Could not encode a migration batch as JSON.');
            }
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = $body;
            $response = wp_safe_remote_post($this->url . $path, $args);
        } else {
            $response = wp_safe_remote_get($this->url . $path, $args);
        }
        if (is_wp_error($response)) {
            WP_CLI::error('Lattis request failed: ' . $response->get_error_code());
        }
        $status = wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            WP_CLI::error('Lattis rejected the request with HTTP ' . (int) $status . '. Check the token scope, import order, and Core log.');
        }
        $result = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($result)) {
            WP_CLI::error('Lattis returned an invalid JSON response.');
        }
        return $result;
    }

    private function cursor($path, $key) {
        $result = $this->request('GET', $path . '?site=' . rawurlencode($this->site) . '&importKey=' . rawurlencode($key));
        return isset($result['cursor']) ? (string) $result['cursor'] : null;
    }

    private function users($key, $auth_mode) {
        global $wpdb;
        $cursor = $this->cursor('/api/imports/wordpress/users/cursor', $key);
        do {
            $ids = $wpdb->get_col($wpdb->prepare("SELECT ID FROM {$wpdb->users} WHERE ID > %d ORDER BY ID ASC LIMIT %d", (int) $cursor, self::BATCH_SIZE));
            if (!$ids) break;
            $users = array();
            foreach ($ids as $id) {
                $person = get_userdata((int) $id);
                if (!$person || !is_email($person->user_email)) {
                    WP_CLI::error('WordPress user ' . (int) $id . ' has no valid email address.');
                }
                $entry = array(
                    'id' => (string) $id,
                    'email' => (string) $person->user_email,
                    'displayName' => (string) $person->display_name,
                    'roles' => array_values(array_map('strval', $person->roles)),
                );
                if ($auth_mode === 'password') {
                    $hash = (string) $person->user_pass;
                    if ($this->supported_password_hash($hash)) {
                        $entry['passwordHash'] = $hash;
                    } else {
                        WP_CLI::warning('User ID ' . (int) $id . ' has an unsupported password hash; this identity requires verified-email linking.');
                    }
                }
                $users[] = $entry;
            }
            $next = (string) end($ids);
            $this->request('POST', '/api/imports/wordpress/users/batches', array(
                'site' => $this->site, 'importKey' => $key, 'expectedCursor' => $cursor,
                'nextCursor' => $next, 'authMode' => $auth_mode, 'users' => $users,
            ));
            $cursor = $next;
            WP_CLI::log('Imported users through WordPress ID ' . $cursor . '.');
        } while (count($ids) === self::BATCH_SIZE);
        if ($auth_mode === 'password') {
            WP_CLI::success('User identities imported. Supported WordPress passwords work at first Lattis sign-in; hashes are replaced after use.');
        } else {
            WP_CLI::success('User identities imported. Lattis accounts require verified email and a separate claim.');
        }
    }

    private function supported_password_hash($hash) {
        if (strpos($hash, '$wp') === 0) $hash = substr($hash, 3);
        if (preg_match('/^\$2[aby]\$(0[4-9]|1[0-4])\$[.\/A-Za-z0-9]{53}$/D', $hash)) return true;
        if (!preg_match('/^\$P\$[.\/0-9A-Za-z]{31}$/D', $hash)) return false;
        $position = strpos('./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', $hash[3]);
        return $position !== false && $position >= 7 && $position <= 20;
    }

    private function media() {
        global $wpdb;
        $uploads = wp_get_upload_dir();
        $root = realpath($uploads['basedir'] ?? '');
        if ($root === false) WP_CLI::error('WordPress uploads directory is unavailable.');
        $cursor = 0;
        do {
            $ids = $wpdb->get_col($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_type = %s AND ID > %d ORDER BY ID ASC LIMIT %d", 'attachment', $cursor, self::BATCH_SIZE));
            if (!$ids) break;
            foreach ($ids as $id) {
                $cursor = (int) $id;
                $mime = (string) get_post_mime_type($cursor);
                if (!in_array($mime, self::MIME_TYPES, true)) {
                    WP_CLI::warning('Skipping unsupported media ID ' . $cursor . ' (' . $mime . ').');
                    continue;
                }
                $path = get_attached_file($cursor, true);
                $real = $path ? realpath($path) : false;
                if ($real === false || strpos($real, $root . DIRECTORY_SEPARATOR) !== 0 || !is_file($real) || !is_readable($real)) {
                    WP_CLI::error('Media ID ' . $cursor . ' is missing or outside the uploads directory.');
                }
                $size = filesize($real);
                if ($size === false || $size < 1 || $size > self::MAX_MEDIA_BYTES) {
                    WP_CLI::error('Media ID ' . $cursor . ' is empty or exceeds 12 MiB.');
                }
                $bytes = file_get_contents($real);
                if ($bytes === false || strlen($bytes) !== $size) {
                    WP_CLI::error('Could not read media ID ' . $cursor . '.');
                }
                $urls = array();
                $original_url = wp_get_attachment_url($cursor);
                if ($original_url) $urls[] = $original_url;
                $image_metadata = wp_get_attachment_metadata($cursor);
                if (is_array($image_metadata) && !empty($image_metadata['sizes']) && is_array($image_metadata['sizes'])) {
                    foreach (array_slice(array_keys($image_metadata['sizes']), 0, 29) as $size_name) {
                        $variant = wp_get_attachment_image_src($cursor, $size_name);
                        if (is_array($variant) && !empty($variant[0])) $urls[] = $variant[0];
                    }
                }
                $this->request('POST', '/api/imports/wordpress/media-files', array(
                    'site' => $this->site,
                    'id' => (string) $cursor,
                    'mimeType' => $mime,
                    'altText' => (string) get_post_meta($cursor, '_wp_attachment_image_alt', true),
                    'sha256' => hash('sha256', $bytes),
                    'bytesBase64' => base64_encode($bytes),
                    'metadata' => array('sourceFile' => basename($real), 'sourceUrls' => array_values(array_unique($urls))),
                ));
                WP_CLI::log('Imported media ID ' . $cursor . '.');
            }
        } while (count($ids) === self::BATCH_SIZE);
        WP_CLI::success('Supported media files imported.');
    }

    private function media_map() {
        $map = array();
        $after = null;
        do {
            $path = '/api/imports/wordpress/media-files/map?site=' . rawurlencode($this->site);
            if ($after !== null) $path .= '&after=' . rawurlencode($after);
            $page = $this->request('GET', $path);
            foreach ($page['items'] ?? array() as $item) {
                if (empty($item['id']) || !is_array($item['sourceUrls'] ?? null)) continue;
                $target = $this->url . '/api/media/' . $item['id'] . '/file';
                foreach ($item['sourceUrls'] as $source) {
                    if (!is_string($source) || $source === '') continue;
                    $map[$source] = $target;
                    $map[str_replace('/', '\\/', $source)] = str_replace('/', '\\/', $target);
                }
            }
            $after = $page['next'] ?? null;
        } while ($after !== null);
        return $map;
    }

    private function rewrite_media($value, $map) {
        if (is_string($value)) return strtr($value, $map);
        if (is_array($value)) {
            foreach ($value as $key => $entry) $value[$key] = $this->rewrite_media($entry, $map);
        }
        return $value;
    }

    private function content($key, $publish) {
        global $wpdb;
        $types = get_post_types(array('show_ui' => true), 'objects');
        $allowed = array();
        foreach ($types as $name => $type) {
            if (!in_array($name, array('attachment', 'revision', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation', 'wp_global_styles', 'wp_font_family', 'wp_font_face', 'custom_css', 'customize_changeset'), true)) {
                $allowed[$name] = (string) $type->label;
            }
        }
        if (!$allowed) WP_CLI::error('No migratable content types were found.');
        $media_map = $this->media_map();
        $placeholders = implode(',', array_fill(0, count($allowed), '%s'));
        $cursor = $this->cursor('/api/imports/wordpress/cursor', $key);
        do {
            $sql = "SELECT ID FROM {$wpdb->posts} WHERE post_type IN ($placeholders) AND ID > %d AND post_status NOT IN ('auto-draft','inherit') ORDER BY ID ASC LIMIT %d";
            $ids = $wpdb->get_col($wpdb->prepare($sql, array_merge(array_keys($allowed), array((int) $cursor, self::BATCH_SIZE))));
            if (!$ids) break;
            $items = array();
            $terms = array();
            $used_types = array();
            foreach ($ids as $id) {
                $post = get_post((int) $id);
                if (!$post) WP_CLI::error('Content ID ' . (int) $id . ' disappeared during migration.');
                $used_types[$post->post_type] = array('type' => $post->post_type, 'label' => $allowed[$post->post_type], 'publicFields' => array());
                $post_terms = array();
                foreach (get_object_taxonomies($post->post_type) as $taxonomy) {
                    $assigned = get_the_terms($post, $taxonomy);
                    if (!$assigned || is_wp_error($assigned)) continue;
                    foreach ($assigned as $term) {
                        $post_terms[$taxonomy][] = (string) $term->term_id;
                        $terms[$taxonomy . ':' . $term->term_id] = array(
                            'id' => (string) $term->term_id, 'taxonomy' => $taxonomy,
                            'slug' => (string) $term->slug, 'label' => (string) $term->name,
                        );
                    }
                }
                $acf = function_exists('get_fields') ? get_fields((int) $id, false) : false;
                $date = $post->post_date_gmt !== '0000-00-00 00:00:00' ? str_replace(' ', 'T', $post->post_date_gmt) . 'Z' : null;
                $featured = (int) get_post_thumbnail_id((int) $id);
                $body = $this->rewrite_media((string) $post->post_content, $media_map);
                $excerpt = $this->rewrite_media((string) $post->post_excerpt, $media_map);
                $acf = is_array($acf) ? $this->rewrite_media($acf, $media_map) : array();
                $scan = wp_json_encode(array($body, $excerpt), JSON_UNESCAPED_SLASHES);
                if ($scan === false) WP_CLI::error('Could not inspect embedded media in content ID ' . (int) $id . '.');
                preg_match_all('~/api/media/([0-9a-f-]{36})/file~', str_replace('\\/', '/', $scan), $found);
                $embedded = array_values(array_unique($found[1]));
                if (count($embedded) > 100) WP_CLI::error('Content ID ' . (int) $id . ' has more than 100 embedded media files.');
                $items[] = array(
                    'id' => (string) $id, 'type' => $post->post_type,
                    'slug' => $post->post_name ?: 'post-' . $id,
                    'title' => (string) $post->post_title, 'content' => $body,
                    'excerpt' => $excerpt,
                    'status' => $post->post_status === 'trash' ? 'trash' : ($publish && $post->post_status === 'publish' && $post->post_password === '' ? 'publish' : 'draft'),
                    'dateGmt' => $date,
                    'acf' => $acf,
                    'terms' => $post_terms,
                    'featuredMedia' => $featured > 0 ? (string) $featured : null,
                    'embeddedMedia' => $embedded,
                );
                if ((int) $post->post_author > 0) $items[count($items) - 1]['authorId'] = (string) $post->post_author;
            }
            $next = (string) end($ids);
            $this->request('POST', '/api/imports/wordpress/batches', array(
                'site' => $this->site, 'importKey' => $key,
                'expectedCursor' => $cursor, 'nextCursor' => $next,
                'types' => array_values($used_types), 'terms' => array_values($terms),
                'media' => array(), 'items' => $items,
            ));
            $cursor = $next;
            WP_CLI::log('Imported content through WordPress ID ' . $cursor . '.');
        } while (count($ids) === self::BATCH_SIZE);
        WP_CLI::success('Content imported. Frontend themes and templates were not migrated.');
    }
}

WP_CLI::add_command('lattis', 'Lattis_Migrator_Command');
