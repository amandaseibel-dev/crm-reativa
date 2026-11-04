(() => {
'use strict';
// Acesso ao telão com a conta de gestão do CRM ReATIVA One (Supabase Auth).
// A sessão persiste no navegador da TV e renova sozinha; a senha nunca fica
// em arquivo. Expõe window.tvAuth para o app.js anexar o token nas leituras.
const $ = id => document.getElementById(id);
let client = null, chave = '', resolveReady;
const ready = new Promise(r => { resolveReady = r; });

async function lerConfig() {
  try { const r = await fetch('./config.json?t=' + Date.now(), { cache: 'no-store' }); return await r.json(); }
  catch (e) { return {}; }
}
function mostrar(msg) { const o = $('tvAuth'); if (o) o.hidden = false; const e = $('tvAuthErro'); if (e) e.textContent = msg || ''; }
function esconder() { const o = $('tvAuth'); if (o) o.hidden = true; }

async function init() {
  const c = await lerConfig();
  if (!c.supabase_url || !c.supabase_key || !window.supabase) {
    mostrar('Configuração de acesso ausente (supabase_url / supabase_key em config.json).');
    return;
  }
  chave = c.supabase_key;
  client = window.supabase.createClient(c.supabase_url, c.supabase_key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data } = await client.auth.getSession();
  if (data && data.session) { esconder(); resolveReady(); } else { mostrar(''); }
  client.auth.onAuthStateChange((_evento, sessao) => {
    if (sessao) { esconder(); resolveReady(); } else { mostrar(''); }
  });
  const form = $('tvAuthForm');
  if (form) form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = $('tvAuthBtn'); btn.disabled = true; $('tvAuthErro').textContent = '';
    const email = $('tvAuthEmail').value.trim(); const senha = $('tvAuthSenha').value;
    $('tvAuthSenha').value = '';
    const { error } = await client.auth.signInWithPassword({ email, password: senha });
    if (error) $('tvAuthErro').textContent = 'Não foi possível entrar. Confira e-mail e senha.';
    btn.disabled = false;
  });
}

window.tvAuth = {
  ready: () => ready,
  async headers() {
    if (!client) return {};
    const { data } = await client.auth.getSession();
    const token = data && data.session ? data.session.access_token : '';
    return token ? { Authorization: 'Bearer ' + token, apikey: chave } : { apikey: chave };
  },
  async negado(status) {
    if (!client) return;
    if (status === 403) {
      // Conta sem permissão: avisa, mas não apaga a sessão salva no aparelho.
      mostrar('Esta conta não tem permissão para os indicadores da TV.');
      return;
    }
    if (status === 401) await renovarOuEncerrar();
  },
};

// Um 401 pode ser token vencido (renova) ou falha de rede/servidor (mantém a
// sessão). Só encerra localmente quando o próprio Auth recusa o refresh token.
// Nunca usa signOut global: ele revogaria o login em todos os aparelhos.
let renovacao = null;
function renovarOuEncerrar() {
  if (!renovacao) {
    renovacao = (async () => {
      try {
        const { data } = await client.auth.getSession();
        if (!data || !data.session) { mostrar('Sessão encerrada. Entre novamente.'); return; }
        const { error } = await client.auth.refreshSession();
        if (!error) { esconder(); return; }
        const regras = window.tvAuthRegras;
        const tipo = regras ? regras.classificarErroDeSessao(error) : 'transitoria';
        if (tipo === 'invalida') {
          await client.auth.signOut({ scope: 'local' });
          mostrar('Sessão encerrada. Entre novamente.');
        }
      } catch (e) {
        // Falha de conexão: a sessão salva continua valendo; a próxima leitura tenta de novo.
      } finally {
        renovacao = null;
      }
    })();
  }
  return renovacao;
}

init();
})();
