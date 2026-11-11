import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Carrega como o navegador faz: script que publica window.tvDestaques.
const pasta = dirname(fileURLToPath(import.meta.url));
const janela = {};
new Function('window', readFileSync(join(pasta, 'tv-destaques.js'), 'utf8'))(janela);
const D = janela.tvDestaques;
const app = readFileSync(join(pasta, 'app.js'), 'utf8');
const html = readFileSync(join(pasta, 'index.html'), 'utf8');

describe('dinheiro: centavos reais, sem casa decimal inventada', () => {
  it('fonte em centavos mostra R$ 40.842,37', () => {
    expect(D.dinheiro(40842.37, 'centavos')).toBe('R$ 40.842,37');
    expect(D.dinheiro(40841.55, 'centavos')).toBe('R$ 40.841,55');
  });
  it('fonte inteira (snapshot) não ganha ",00"', () => {
    expect(D.dinheiro(129333, 'inteiro')).toBe('R$ 129.333');
  });
  it('valor ausente, negativo ou inválido vira travessão', () => {
    for (const v of [null, undefined, NaN, -1, '10']) expect(D.dinheiro(v, 'centavos')).toBe('—');
  });
});

describe('meta x projeção', () => {
  it('percentual é sobre a META, não sobre a projeção', () => {
    // 40.841,55 de 122.400 = 33,4% (com a projeção 129.333 daria 31,6%)
    expect(D.percentual(D.percentualMeta(40841.55, 122400))).toBe('33,4%');
  });
  it('sem meta não inventa percentual', () => {
    expect(D.percentualMeta(40841.55, null)).toBeNull();
    expect(D.percentualMeta(40841.55, 0)).toBeNull();
  });
  it('a tela usa meta_honorarios_mes, e a projeção nunca entra no cálculo da barra', () => {
    expect(app).toMatch(/percentualMeta\(r\.honorarios_mes,r\.meta_honorarios_mes\)/);
    expect(app).not.toMatch(/honorarios_mes\/r\.projecao_honorarios_mes/);
  });
});

describe('ritmo pelos dias úteis do CRM', () => {
  it('acima do ritmo: 6 de 19 dias úteis, meta 122.400', () => {
    const r = D.ritmo(40841.55, 122400, 6, 19);
    expect(r.situacao).toBe('acima');
    expect(r.esperado).toBeCloseTo(38652.63, 2);
    expect(r.diferenca).toBeCloseTo(2188.92, 2);
  });
  it('abaixo do ritmo', () => {
    expect(D.ritmo(30000, 122400, 6, 19).situacao).toBe('abaixo');
  });
  it('sem dias úteis ou sem meta → null', () => {
    expect(D.ritmo(1, 122400, 6, 0)).toBeNull();
    expect(D.ritmo(1, null, 6, 19)).toBeNull();
  });
});

describe('rankings: nada fabricado', () => {
  it('lista ausente = dado indisponível (null), lista vazia = ninguém pontuou', () => {
    expect(D.ranking(null)).toBeNull();
    expect(D.ranking(undefined)).toBeNull();
    expect(D.ranking([])).toEqual([]);
  });
  it('no máximo 3, posições 1..3, ignora linha sem nome', () => {
    const r = D.ranking([{ nome: 'A', qtd: 3 }, { nome: '' }, { nome: 'B', qtd: 2 }, { nome: 'C', qtd: 1 }, { nome: 'D', qtd: 1 }]);
    expect(r.map((x) => [x.posicao, x.nome])).toEqual([[1, 'A'], [2, 'B'], [3, 'C']]);
  });
  it('com um só colocado, mostra um só — não completa o pódio', () => {
    expect(D.ranking([{ nome: 'João', qtd: 29 }])).toHaveLength(1);
  });
  it('resultado: valor em dinheiro ou quantidade com unidade', () => {
    const [hon, , pag] = D.RANKINGS;
    expect(D.resultadoDe({ valor: 2907.12 }, hon, 'centavos')).toBe('R$ 2.907,12');
    expect(D.resultadoDe({ qtd: 1 }, pag, 'centavos')).toBe('1 pagamento');
    expect(D.resultadoDe({ qtd: 29 }, pag, 'centavos')).toBe('29 pagamentos');
  });
  it('os 4 rankings pedidos, com período', () => {
    expect(D.RANKINGS.map((r) => [r.chave, r.periodo])).toEqual([
      ['top_honorario_pagamento_mes', 'mes'],
      ['top_recuperado_mes', 'mes'],
      ['top_pagamentos_hoje', 'hoje'],
      ['top_acordos_hoje', 'hoje'],
    ]);
  });
});

describe('foto e iniciais', () => {
  it('só aceita URL https (a assinada do CRM); o resto cai nas iniciais', () => {
    expect(D.fotoSegura('https://x.supabase.co/storage/v1/object/sign/a.png?token=1')).toMatch(/^https:/);
    for (const v of ['http://x/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', '/a.png', null]) expect(D.fotoSegura(v)).toBeNull();
  });
  it('iniciais e nome curto', () => {
    expect(D.iniciais('Rafaella Souza')).toBe('RS');
    expect(D.iniciais('João')).toBe('J');
    expect(D.iniciais('')).toBe('?');
    expect(D.nomeCurto('RAFAELLA SOUZA')).toBe('Rafaella S.');
  });
});

describe('tela: textos genéricos removidos e o que fica preservado', () => {
  it('não há mais "sem valores individuais" nem "três primeiros colocados em destaque"', () => {
    expect(app).not.toMatch(/Sem valores individuais/i);
    expect(app).not.toMatch(/três primeiros colocados em destaque/i);
  });
  it('destaques do mês: pódio ouro, prata e bronze', () => {
    expect(app).toMatch(/MEDALHAS=\['ouro','prata','bronze'\]/);
    expect(app).toMatch(/dz\.podio_mes/);
  });
  it('destaques do mês não mostram valor do operador', () => {
    const bloco = app.slice(app.indexOf('function destaqueCard'), app.indexOf('// Card central de ranking'));
    expect(bloco).not.toMatch(/dinheiro|valor/);
  });
  it('top recuperado é por pagamento único, não acumulado', () => {
    expect(D.RANKINGS[1].explica).toMatch(/único pagamento/);
  });
  it('logo natalino continua no topo e na tela de acesso', () => {
    expect(html.match(/logo-reativa-natal\.png/g)).toHaveLength(2);
  });
  it('argumentações (almanaque), resultados de hoje e fila do receptivo seguem ligados', () => {
    expect(app).toMatch(/kind:'treino'/);
    for (const id of ['honorariosHoje', 'recuperadoHoje', 'pagamentosHoje', 'acordosHoje', 'queueItems']) expect(html).toContain(`id="${id}"`);
  });
  it('rankings diários usam o fuso de Brasília', () => {
    expect(app).toMatch(/timeZone:'America\/Sao_Paulo'/);
  });
});
