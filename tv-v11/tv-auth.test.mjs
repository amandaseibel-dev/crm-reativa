import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Carrega o arquivo como o navegador faz: script que publica window.tvAuthRegras.
const pasta = dirname(fileURLToPath(import.meta.url));
const janela = {};
new Function('window', readFileSync(join(pasta, 'tv-auth-regras.js'), 'utf8'))(janela);
const { classificarErroDeSessao } = janela.tvAuthRegras;

describe('classificarErroDeSessao (sessão da TV)', () => {
  it('refresh token recusado pelo Auth é sessão inválida', () => {
    expect(classificarErroDeSessao({ code: 'refresh_token_not_found', status: 400 })).toBe('invalida');
    expect(classificarErroDeSessao({ code: 'refresh_token_already_used', status: 400 })).toBe('invalida');
    expect(classificarErroDeSessao({ code: 'session_not_found', status: 403 })).toBe('invalida');
  });

  it('status 401/403/400 do Auth sem código conhecido também é inválida', () => {
    expect(classificarErroDeSessao({ status: 401 })).toBe('invalida');
    expect(classificarErroDeSessao({ status: 403 })).toBe('invalida');
  });

  it('falha de rede é transitória e preserva a sessão', () => {
    expect(classificarErroDeSessao(new TypeError('Failed to fetch'))).toBe('transitoria');
    expect(classificarErroDeSessao({ status: 0, message: 'network' })).toBe('transitoria');
  });

  it('erro 5xx do servidor é transitório', () => {
    expect(classificarErroDeSessao({ status: 500 })).toBe('transitoria');
    expect(classificarErroDeSessao({ status: 503, code: 'unexpected_failure' })).toBe('transitoria');
  });

  it('ausência de erro não encerra nada', () => {
    expect(classificarErroDeSessao(null)).toBe('transitoria');
    expect(classificarErroDeSessao(undefined)).toBe('transitoria');
  });
});
