import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Testes de fiação do telão (app.js): garantem que a assinatura do sinal da fila,
// o debounce e a recuperação periódica continuam ligados como o desenho prevê.
// O app.js é um script de navegador (IIFE com DOM), então a verificação é de fonte.
const pasta = dirname(fileURLToPath(import.meta.url));
const fonte = readFileSync(join(pasta, 'app.js'), 'utf8');
const config = JSON.parse(readFileSync(join(pasta, 'config.json'), 'utf8'));

describe('telão: sinal da fila (fila_sinal)', () => {
  it('assina o canal de fila_sinal em public, por Realtime', () => {
    expect(fonte).toMatch(/channel\('tv-sinal-fila'\)/);
    expect(fonte).toMatch(/table:'fila_sinal'/);
    expect(fonte).toMatch(/schema:'public'/);
  });

  it('usa debounce de 1,5 s: vários eventos viram uma única leitura', () => {
    expect(fonte).toMatch(/function scheduleQueueRefresh\(\)/);
    expect(fonte).toMatch(/clearTimeout\(queueTimer\)/);
    expect(fonte).toMatch(/setTimeout\(\(\)=>\{queueTimer=null;readSnapshot\(\);\},1500\)/);
  });

  it('não tem mais ciclo de 5 s da fila (sem polling de receptivo)', () => {
    expect(fonte).not.toMatch(/setInterval\(readQueue/);
    expect(fonte).not.toMatch(/setInterval\(renderQueue,5000\)/);
  });
});

describe('telão: recuperação por leitura periódica', () => {
  it('mantém a leitura periódica do snapshot como fallback do Realtime', () => {
    expect(fonte).toMatch(/setInterval\(readSnapshot,Math\.max\(10,Number\(config\.intervalo_dados_segundos\)\|\|30\)\*1000\)/);
  });

  it('o intervalo configurado é de 60 s', () => {
    expect(config.intervalo_dados_segundos).toBe(60);
  });
});

describe('telão: pódio ligado à projeção', () => {
  it('pódio redesenha só quando atualizado_em muda', () => {
    expect(fonte).toMatch(/function refreshPodium\(\)/);
    expect(fonte).toMatch(/if\(stamp===podiumStamp\)return;/);
  });
});
