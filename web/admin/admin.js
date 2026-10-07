const byId = (id) => document.getElementById(id);
const view = byId('view');
const titles = { overview:'Overview',content:'Content',modules:'Nodes & Shards',geode:'Geode',users:'Users',media:'Media',sales:'Sales',forge:'Forge AI',settings:'Settings' };
let current = 'overview';

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}
function card(title) { const item = node('section',undefined,'card'); item.append(node('h2',title)); return item; }
function paragraph(text,className='muted') { return node('p',text,className); }
function button(text,onClick,className='secondary') { const item=node('button',text,className); item.type='button'; item.addEventListener('click',() => { try { Promise.resolve(onClick()).catch(showError); } catch(error) { showError(error); } }); return item; }
function field(label,type='text',value='') {
  const wrap=node('label',label); const input=node(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type=type;
  input.value=value ?? ''; wrap.append(input); return { wrap,input };
}
function formSubmit(form,callback) { form.addEventListener('submit',(event) => { event.preventDefault(); void callback().catch(showError); }); }
function showError(error) { const notice=byId('notice'); notice.textContent=error instanceof Error ? error.message : String(error); notice.className='error'; }
function notice(text) { const target=byId('notice'); target.textContent=text; target.className='success'; }
function clear() { view.replaceChildren(); byId('notice').textContent=''; }
async function api(path,options={}) {
  const response=await fetch(path,{ credentials:'same-origin',...options,headers:{ ...(options.body ? { 'content-type':'application/json' } : {}),...options.headers } });
  const text=await response.text(); let body;
  try { body=text ? JSON.parse(text) : null; } catch { body=text; }
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}
function table(headers,rows) {
  const item=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody');
  for (const title of headers) tr.append(node('th',title)); head.append(tr);
  for (const cells of rows) { const row=node('tr'); for (const cell of cells) { const td=node('td'); if (cell instanceof Node) td.append(cell); else td.textContent=String(cell ?? ''); row.append(td); } body.append(row); }
  item.append(head,body); return item;
}
async function navigate(name) {
  current=name; byId('view-title').textContent=titles[name];
  document.querySelectorAll('#nav button').forEach((item) => item.classList.toggle('active',item.dataset.view===name));
  clear(); view.append(paragraph('Loading…'));
  try { clear(); await ({ overview,content,modules,geode,users,media,sales,forge,settings })[name](); }
  catch(error) { clear(); showError(error); }
}
async function overview() {
  const data=await api('/api/admin/overview');
  const grid=node('div',undefined,'grid');
  for (const [title,key] of [['Content types','contentTypes'],['Entries','entries'],['Media files','media'],['Users','users']]) {
    const item=card(title); item.append(node('div',data[key],'metric')); grid.append(item);
  }
  view.append(grid);
  const next=card('Develop this application');
  next.append(paragraph('Connect an MCP client to this instance to read and edit its source workspace without transferring files over SSH. Changes to source files still need the deployment process to activate them.'));
  next.append(button('Open MCP settings',() => navigate('settings'),'primary'));
  view.append(next);
}
async function content() {
  const types=await api('/api/admin/content-types');
  const layout=node('div',undefined,'columns'),left=card('Content types'),right=card('Entries');
  const list=node('div',undefined,'rows');
  for (const type of types) list.append(button(`${type.label} · ${type.key}`,() => void entries(type,right).catch(showError)));
  if (!types.length) list.append(paragraph('No content types yet.'));
  left.append(list);
  const create=card('Create a content type'),form=node('form');
  const key=field('Type key'),label=field('Label'),fields=field('Fields (JSON array)','textarea','[]');
  form.append(key.wrap,label.wrap,fields.wrap,node('button','Create type','primary'));
  formSubmit(form,async () => {
    await api('/api/admin/content-types',{ method:'POST',body:JSON.stringify({ key:key.input.value,label:label.input.value,fields:JSON.parse(fields.input.value) }) });
    await navigate('content'); notice('Content type created.');
  });
  create.append(form); left.append(create); right.append(paragraph('Select a content type.'));
  layout.append(left,right); view.append(layout);
}
async function entries(type,target) {
  target.replaceChildren(node('h2',type.label));
  const toolbar=node('div',undefined,'toolbar');
  toolbar.append(button('New entry',() => editor(type,null,target),'primary'));
  target.append(toolbar);
  const items=await api(`/api/admin/content?type=${encodeURIComponent(type.key)}`);
  const list=node('div',undefined,'rows');
  for (const item of items) {
    const row=node('div',undefined,'row');
    row.append(node('span',`${item.title || item.slug} · ${item.status}`),button('Edit',() => editor(type,item,target)));
    list.append(row);
  }
  target.append(items.length ? list : paragraph('No entries in this type.'));
}
function editor(type,item,target) {
  target.replaceChildren(node('h2',item ? 'Edit entry' : 'New entry'));
  const form=node('form');
  const title=field('Title','text',item?.title),slug=field('Slug','text',item?.slug),excerpt=field('Excerpt','textarea',item?.excerpt),body=field('Body','textarea',item?.body),data=field('Custom fields (JSON)','textarea',JSON.stringify(item?.data ?? {},null,2));
  const status=field('Status'); const select=node('select');
  for (const value of ['draft','published','archived']) { const option=node('option',value); option.value=value; option.selected=value===(item?.status ?? 'draft'); select.append(option); }
  status.input.replaceWith(select); status.input=select;
  const specification=paragraph(`Fields: ${type.fields.map((part) => `${part.name} (${part.type}${part.required ? ', required' : ''})`).join(', ') || 'none'}`,'small muted');
  form.append(title.wrap,slug.wrap,status.wrap,excerpt.wrap,body.wrap,specification,data.wrap,node('button','Save entry','primary'));
  formSubmit(form,async () => {
    const content={ type:type.key,title:title.input.value,slug:slug.input.value,status:status.input.value,excerpt:excerpt.input.value,body:body.input.value,data:JSON.parse(data.input.value) };
    const payload=item ? { expectedRevision:item.revision,content } : content;
    await api(item ? `/api/admin/content/${item.id}` : '/api/admin/content',{ method:item ? 'PUT' : 'POST',body:JSON.stringify(payload) });
    await entries(type,target); notice('Entry saved.');
  });
  target.append(form,button('Back to entries',() => void entries(type,target).catch(showError)));
}
function svgElement(tag,attributes={},text) {
  const element=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for (const [key,value] of Object.entries(attributes)) element.setAttribute(key,String(value));
  if (text !== undefined) element.textContent=String(text);
  return element;
}
async function modules() {
  const data=await api('/api/admin/modules');
  const panel=card('Application graph');
  panel.append(paragraph('Packages, Nodes, Shard routes and declared process or service connections. Runtime invocation paths are not inferred from source code.'));
  const wrap=node('div',undefined,'graph-wrap');
  if (!data.modules.length) { wrap.append(paragraph('No trusted local packages are registered.')); panel.append(wrap); view.append(panel); return; }
  const positions=new Map(); let width=40;
  data.modules.forEach((module,index) => {
    const x=30+index*310; width=x+290;
    positions.set(module.name,{ x:x+120,y:55 });
    module.nodes.forEach((item,number) => positions.set(item.name,{ x:x+120,y:153+number*54 }));
    module.routes.forEach((item,number) => positions.set(`${module.name}:${item.name}`,{ x:x+120,y:153+(module.nodes.length+number)*54 }));
  });
  const extras=data.graph.vertices.filter((item) => !positions.has(item.id));
  if (extras.length) {
    const x=30+data.modules.length*310;
    extras.forEach((item,index) => positions.set(item.id,{ x:x+120,y:55+index*54 }));
    width=x+290;
  }
  const height=Math.max(230,80+extras.length*54,...data.modules.map((item) => 195+(item.nodes.length+item.routes.length)*54));
  const svg=svgElement('svg',{ viewBox:`0 0 ${width} ${height}`,width,height,role:'img','aria-label':'Package dependency graph' });
  for (const edge of data.graph.edges) {
    const from=positions.get(edge.from),to=positions.get(edge.to);
    if (from && to) svg.append(svgElement('line',{ x1:from.x,y1:from.y+22,x2:to.x,y2:to.y-20,stroke:edge.kind==='contains' ? '#9acbb6' : '#bca476','stroke-width':edge.kind==='contains' ? 2 : 1.5,'stroke-dasharray':edge.kind==='contains' ? '' : '5 4' }));
  }
  for (const vertex of data.graph.vertices) {
    const position=positions.get(vertex.id); if (!position) continue;
    const main=!['node','shard-route','reference'].includes(vertex.kind);
    svg.append(svgElement('rect',{ x:position.x-115,y:position.y-21,width:230,height:42,rx:9,fill:main ? '#174e46' : '#e5f2eb',stroke:main ? '#174e46' : '#bfd8cd' }));
    const title=vertex.label.length>31 ? `${vertex.label.slice(0,29)}…` : vertex.label;
    svg.append(svgElement('text',{ x:position.x,y:position.y+5,'text-anchor':'middle','font-size':main ? 13 : 11,fill:main ? '#fff' : '#26554b','font-family':'system-ui' },title));
  }
  wrap.append(svg); panel.append(wrap); view.append(panel);
  const list=card('Registered packages');
  for (const module of data.modules) list.append(paragraph(`${module.name} · ${module.kind} · ${module.version} · ${module.nodes.length} Nodes · ${module.routes.length} routes`));
  view.append(list);
}
async function geode() {
  const panel=card('Geode marketplace'),toolbar=node('form',undefined,'toolbar'),query=field('Search packages');
  query.input.placeholder='Search Nodes and Shards';
  toolbar.append(query.wrap,node('button','Search','primary')); panel.append(toolbar);
  const results=node('div',undefined,'rows'); panel.append(results); view.append(panel);
  async function search() {
    const data=await api(`/api/admin/geode?q=${encodeURIComponent(query.input.value)}`);
    results.replaceChildren();
    if (!data.available) { results.append(paragraph('Geode is not configured for this instance.')); return; }
    for (const item of data.packages) {
      const row=node('div',undefined,'row');
      const label=node('div'); label.append(node('strong',item.name),paragraph(`${item.kind} · ${item.latest_version ?? 'No release'} · ${item.description || ''}`,'small muted'));
      row.append(label,node('span',item.visibility,'pill')); results.append(row);
    }
    if (!data.packages.length) results.append(paragraph('No packages found.'));
  }
  formSubmit(toolbar,search); await search();
}
async function users() {
  const [people,roles]=await Promise.all([api('/api/admin/users'),api('/api/admin/roles')]);
  const panel=card('Users');
  panel.append(table(['Name','Email','Verified','Roles'],people.map((person) => [person.name,person.email,person.emailVerified ? 'Yes' : 'No',roles.assignments.filter((entry) => entry.user_id===person.id).map((entry) => entry.role_id).join(', ') || '—'])));
  view.append(panel);
  const assign=card('Assign an existing role'),form=node('form');
  const email=field('User email'),role=field('Role'); const select=node('select');
  for (const optionValue of roles.roles.filter((item) => item.id!=='owner')) { const option=node('option',optionValue.id); option.value=optionValue.id; select.append(option); }
  role.input.replaceWith(select); role.input=select;
  form.append(email.wrap,role.wrap,node('button','Assign role','primary'));
  formSubmit(form,async () => {
    const person=people.find((item) => item.email.toLowerCase()===email.input.value.toLowerCase());
    if (!person) throw new Error('User is not in the current list.');
    await api(`/api/admin/users/${encodeURIComponent(person.id)}/roles`,{ method:'POST',body:JSON.stringify({ roleId:role.input.value }) });
    await navigate('users'); notice('Role assigned.');
  });
  assign.append(form,button('Remove assignment',async () => {
    const person=people.find((item) => item.email.toLowerCase()===email.input.value.toLowerCase());
    if (!person) throw new Error('User is not in the current list.');
    await api(`/api/admin/users/${encodeURIComponent(person.id)}/roles/${encodeURIComponent(role.input.value)}`,{ method:'DELETE' });
    await navigate('users'); notice('Assignment removed.');
  },'danger')); view.append(assign);
  const create=card('Create a role'),roleForm=node('form'),id=field('Role ID'),description=field('Description'),grants=field('Grants (JSON array)','textarea','[{"action":"content.read","resourceType":"content"}]');
  roleForm.append(id.wrap,description.wrap,grants.wrap,node('button','Create role','primary'));
  formSubmit(roleForm,async () => {
    await api('/api/admin/roles',{ method:'POST',body:JSON.stringify({ id:id.input.value,description:description.input.value,grants:JSON.parse(grants.input.value) }) });
    await navigate('users'); notice('Role created.');
  });
  create.append(roleForm); view.append(create);
}
async function media() {
  const items=await api('/api/admin/media'),panel=card('Media library');
  panel.append(paragraph('Stored media metadata. Upload and file operations remain in their dedicated Nodes and routes.'));
  panel.append(items.length ? table(['ID','Type','Alt text','Created'],items.map((item) => [item.id,item.mimeType,item.altText,new Date(item.createdAt).toLocaleString()])) : node('div','No media yet.','empty'));
  view.append(panel);
}
async function sales() {
  const data=await api('/api/admin/sales'),panel=card('Sales');
  if (!data.available) panel.append(paragraph('The optional Commerce Node is not installed in this application.'));
  else panel.append(data.sales.length ? table(['Sale ID','Amount','Status','Fulfillment'],data.sales.map((sale) => [sale.sale_id,`${sale.total_minor} ${sale.currency} minor units`,sale.status,sale.fulfillment_status])) : node('div','No sales yet.','empty'));
  view.append(panel);
}
async function forge() {
  const panel=card('Forge AI');
  panel.append(paragraph('Forge is reserved for a future optional AI Node. No model credentials or AI actions are enabled by this panel.'));
  view.append(panel);
}
async function settings() {
  const [data,tokens]=await Promise.all([api('/api/admin/settings'),api('/api/admin/tokens')]);
  const addresses=card('Instance addresses');
  addresses.append(table(['Service','Address'],[['Admin panel',data.adminUrl],['Application API',data.appUrl],['Workspace MCP',data.mcpUrl ?? 'Disabled'],['Geode',data.geodeUrl ?? 'Not configured']]));
  addresses.append(paragraph('Customer white-label panels use separate applications and origins. Updating this address requires DNS, reverse proxy and process configuration.','small muted'));
  const addressForm=node('form'),address=field('Proposed admin URL','url',data.pendingAdminUrl ?? data.adminUrl);
  addressForm.append(address.wrap,node('button','Save proposed address','secondary'));
  formSubmit(addressForm,async () => {
    await api('/api/admin/settings/admin-url',{ method:'PUT',body:JSON.stringify({ url:address.input.value }) });
    await navigate('settings'); notice('Address saved as a proposal. Update LATTIS_ADMIN_BASE_URL and the reverse proxy to activate it.');
  });
  addresses.append(addressForm);
  if (data.pendingAdminUrl) addresses.append(paragraph(`Proposed: ${data.pendingAdminUrl}`,'small muted'));
  view.append(addresses);
  const secrets=card('Secret vault');
  secrets.append(paragraph('Secret values are encrypted before database storage and are never returned here. LATTIS_VAULT_KEY must be supplied to the admin and application processes.'));
  secrets.append(data.secrets.length ? table(['Name','Provider','Allowed package','Version','Action'],data.secrets.map((item) => [item.name,item.provider,item.allowedPackage,item.version ?? '—',item.provider==='vault' ? button('Rotate',() => {
    const rotate=node('form'),next=field(`New value for ${item.name}`,'password');
    rotate.append(next.wrap,node('button','Save new value','primary'));
    formSubmit(rotate,async () => {
      await api(`/api/admin/secrets/${encodeURIComponent(item.name)}`,{ method:'PUT',body:JSON.stringify({ expectedVersion:item.version,value:next.input.value }) });
      next.input.value=''; await navigate('settings'); notice('Secret rotated.');
    });
    secrets.append(rotate);
  }) : '—'])) : paragraph('No secret references yet.'));
  const form=node('form'),name=field('Secret name'),pkg=field('Allowed package'),value=field('Secret value','password');
  pkg.input.placeholder='@publisher/package'; form.append(name.wrap,pkg.wrap,value.wrap,node('button','Store secret','primary'));
  formSubmit(form,async () => {
    await api('/api/admin/secrets',{ method:'POST',body:JSON.stringify({ name:name.input.value,allowedPackage:pkg.input.value,value:value.input.value }) });
    value.input.value=''; await navigate('settings'); notice('Secret stored.');
  });
  secrets.append(node('h3','Add secret'),form); view.append(secrets);
  const mail=card('Email delivery');
  mail.append(paragraph(data.mailWebhookConfigured ? 'Mail webhook is configured in the server environment.' : 'Mail webhook is not configured. Verification and password reset emails need a delivery provider.'));
  mail.append(paragraph('Direct SMTP transport is not implemented yet. The current application uses LATTIS_MAIL_WEBHOOK_URL and its token.','small muted'));
  view.append(mail);
  const mcp=card('MCP access keys');
  mcp.append(paragraph('Each key can be revoked. The secret is shown once when created. Give read, write and scaffolding scopes only as needed.'));
  const rows=node('div',undefined,'rows');
  for (const item of tokens) {
    const row=node('div',undefined,'row');
    row.append(node('span',`${item.name} · ${item.scopes.join(', ')} · expires ${new Date(item.expiresAt).toLocaleDateString()}${item.revokedAt ? ' · revoked' : ''}`));
    if (!item.revokedAt) row.append(button('Revoke',async () => {
      await api(`/api/admin/tokens/${item.id}`,{ method:'DELETE' }); await navigate('settings'); notice('Key revoked.');
    },'danger'));
    rows.append(row);
  }
  mcp.append(rows);
  const keyForm=node('form'),keyName=field('Key name'),days=field('Validity (days)','number','30');
  const scopeRow=node('div',undefined,'toolbar'); const checks=[];
  for (const [scope,label] of [['mcp-read:workspace','Read'],['mcp-write:workspace','Write'],['mcp-scaffold:workspace','Scaffold']]) {
    const wrap=node('label',label),input=node('input'); input.type='checkbox'; input.checked=true; input.style.width='auto'; wrap.prepend(input); scopeRow.append(wrap); checks.push([scope,input]);
  }
  keyForm.append(keyName.wrap,days.wrap,scopeRow,node('button','Create MCP key','primary'));
  const oneTime=node('pre',undefined,'code');
  formSubmit(keyForm,async () => {
    const scopes=checks.filter((entry) => entry[1].checked).map((entry) => entry[0]);
    const key=await api('/api/admin/tokens',{ method:'POST',body:JSON.stringify({ name:keyName.input.value,expiresDays:Number(days.input.value),scopes }) });
    oneTime.textContent=`Copy this key now. It will not be shown again:\n${key.token}`;
    keyName.input.value=''; notice('MCP key created.');
  });
  mcp.append(node('h3','Create a key'),keyForm,oneTime); view.append(mcp);
}

document.querySelectorAll('#nav button').forEach((item) => item.addEventListener('click',() => void navigate(item.dataset.view)));
byId('sign-out').addEventListener('click',async () => {
  try { await api('/api/auth/sign-out',{ method:'POST',body:JSON.stringify({}) }); } finally { location.reload(); }
});
formSubmit(byId('login-form'),async () => {
  byId('login-error').textContent='';
  const form=new FormData(byId('login-form'));
  try {
    await api('/api/auth/sign-in/email',{ method:'POST',body:JSON.stringify({ email:form.get('email'),password:form.get('password') }) });
    const user=await api('/api/admin/session');
    byId('login').hidden=true; byId('shell').hidden=false; byId('account').textContent=user.email;
    await navigate('overview');
  } catch(error) { byId('login-error').textContent=error.message; }
});
void api('/api/admin/session').then((user) => {
  byId('login').hidden=true; byId('shell').hidden=false; byId('account').textContent=user.email;
  return navigate('overview');
}).catch(() => { byId('login').hidden=false; byId('shell').hidden=true; });
