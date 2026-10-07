class LattisVideoPlayer extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; max-width: 100%; font: inherit; }
        .frame { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #111; color: #fff; display: grid; place-items: center; }
        video { display: none; width: 100%; height: 100%; background: #111; }
        button { font: inherit; padding: .7em 1.3em; cursor: pointer; }
        p { margin: 1rem; text-align: center; }
      </style>
      <div class="frame">
        <button type="button">Odtwórz wideo</button>
        <video controls preload="metadata" playsinline></video>
        <p role="status" hidden></p>
      </div>`;
    const button = root.querySelector('button');
    button.addEventListener('click', () => void this.start());
  }

  disconnectedCallback() {
    const video = this.shadowRoot?.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  async start() {
    const id = this.getAttribute('video-id');
    const root = this.shadowRoot;
    const button = root.querySelector('button');
    const video = root.querySelector('video');
    const status = root.querySelector('[role="status"]');
    video.addEventListener('error', () => {
      status.textContent = 'Nie udało się odczytać strumienia wideo.';
      status.hidden = false;
    }, { once: true });
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      status.textContent = 'Brak poprawnego identyfikatora wideo.';
      status.hidden = false;
      return;
    }
    button.disabled = true;
    status.textContent = 'Przygotowuję odtwarzanie…';
    status.hidden = false;
    try {
      const base = (this.getAttribute('api-base') || location.origin).replace(/\/$/, '');
      const response = await fetch(`${base}/api/videos/${encodeURIComponent(id)}/playback`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (response.status === 501) throw new Error('protected');
      if (!response.ok) throw new Error('Playback unavailable');
      const playback = await response.json();
      if (typeof playback.streamUrl !== 'string' || !playback.streamUrl.startsWith('/api/videos/')) throw new Error('Invalid playback URL');
      if (playback.downloadUi === 'hide') video.setAttribute('controlsList', 'nodownload');
      else video.removeAttribute('controlsList');
      if (typeof playback.title === 'string') video.setAttribute('aria-label', playback.title);
      if (new URL(base).origin !== location.origin) video.crossOrigin = 'use-credentials';
      video.src = base + playback.streamUrl;
      button.hidden = true;
      status.hidden = true;
      video.style.display = 'block';
      void video.play().catch(() => {});
    } catch (error) {
      video.style.display = 'none';
      status.textContent = error instanceof Error && error.message === 'protected'
        ? 'To wideo wymaga chronionego odtwarzacza, który nie jest jeszcze skonfigurowany.'
        : 'Nie można odtworzyć wideo. Sprawdź dostęp i spróbuj ponownie.';
      status.hidden = false;
      button.hidden = false;
      button.disabled = false;
    }
  }
}

if (!customElements.get('lattis-video-player')) customElements.define('lattis-video-player', LattisVideoPlayer);
