(function (raiz) {
  'use strict';
  // Regras puras de sessão da TV (sem DOM, testáveis em node).
  // Decide se um erro do Supabase Auth significa sessão realmente inválida
  // ('invalida') ou falha temporária de conexão/servidor ('transitoria').
  // Só 'invalida' pode encerrar a sessão salva no aparelho.
  const CODIGOS_INVALIDA = [
    'refresh_token_not_found',
    'refresh_token_already_used',
    'session_not_found',
    'session_expired',
    'bad_jwt',
    'invalid_grant',
  ];
  function classificarErroDeSessao(erro) {
    if (!erro) return 'transitoria';
    const codigo = String(erro.code || '');
    if (CODIGOS_INVALIDA.indexOf(codigo) >= 0) return 'invalida';
    const status = Number(erro.status);
    // 400/401/403 vindos do Auth = credencial recusada pelo servidor.
    // Status 0, ausente ou 5xx = rede/servidor fora: sessão preservada.
    if (status === 400 || status === 401 || status === 403) return 'invalida';
    return 'transitoria';
  }
  const api = { classificarErroDeSessao, CODIGOS_INVALIDA };
  raiz.tvAuthRegras = api;
})(typeof window !== 'undefined' ? window : globalThis);
