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
    const r = D.ranking([{ nome: 'A' }, { nome: '' }, { nome: 'B' }, { nome: 'C' }, { nome: 'D' }]);
    expect(r.map((x) => [x.posicao, x.nome])).toEqual([[1, 'A'], [2, 'B'], [3, 'C']]);
  });
  it('com um só colocado, mostra um só — não completa o pódio', () => {
    expect(D.ranking([{ nome: 'João' }])).toHaveLength(1);
  });
  it('os 4 rankings pedidos, com período e critério', () => {
    expect(D.RANKINGS.map((r) => [r.chave, r.periodo])).toEqual([
      ['top_honorario_pagamento_mes', 'mes'],
      ['top_recuperado_mes', 'mes'],
      ['top_pagamentos_hoje', 'hoje'],
      ['top_acordos_hoje', 'hoje'],
    ]);
  });
  it('top honorários: critério explícito de pagamento único; top recuperado: acumulado do mês', () => {
    expect(D.RANKINGS[0].criterio).toMatch(/um único pagamento/);
    expect(D.RANKINGS[1].criterio).toMatch(/acumulado no mês/);
  });
});

describe('separação: ranking individual sem valor; total da equipe com valor', () => {
  const edge = readFileSync(join(pasta, '..', 'supabase', 'functions', 'tv-dados', 'index.ts'), 'utf8');
  const sql = readFileSync(join(pasta, '..', 'supabase', 'aguardando_aprovacao', '20261110200000_tv_painel_operadores.sql.pendente'), 'utf8');
  const trecho = (txt, de, ate) => txt.slice(txt.indexOf(de), txt.indexOf(ate));

  it('ranking() devolve só posição, nome e foto, mesmo se a fonte mandar valor', () => {
    const [item] = D.ranking([{ nome: 'Rafaella', foto: null, valor: 40000, qtd: 3, data: '2026-11-09' }]);
    expect(Object.keys(item).sort()).toEqual(['foto', 'nome', 'posicao']);
  });
  it('a tela não formata valor nem quantidade nos cards de ranking nem no pódio', () => {
    const board = trecho(app, 'function renderBoard', 'function renderQueue');
    const podio = trecho(app, 'function destaqueCard', '// Card central de ranking');
    for (const bloco of [board, podio]) {
      expect(bloco).not.toMatch(/dinheiro|quantidade|money|count\(|\.valor|\.qtd|\.data\b/);
    }
  });
  it('a tv-dados não envia valor nem quantidade por operador', () => {
    const bloco = trecho(edge, 'function pessoa', 'function numOrNull').replace(/\/\/.*$/gm, '');
    expect(bloco).not.toMatch(/\b(valor|qtd|data|honorario|recuperado)\s*:/);
    expect(bloco).toMatch(/return \{ nome: .*foto: /);
  });
  it('a função SQL devolve só id e nome em todo ranking', () => {
    const bloco = trecho(sql, "'podio_mes'", '$function$;');
    const objetos = bloco.match(/jsonb_build_object\([^)]*\)/g) || [];
    expect(objetos.length).toBe(5);
    for (const o of objetos) expect(o).toBe("jsonb_build_object('usuario_id', usuario_id, 'nome', nome)");
  });
  it('totais da equipe seguem com valor e identificados como ReATIVA', () => {
    expect(html).toMatch(/RESULTADOS REATIVA/);
    expect(html).toMatch(/RESULTADO REATIVA · MÊS/);
    for (const id of ['honorariosHoje', 'recuperadoHoje', 'honorariosMes', 'recuperadoMes']) expect(app).toMatch(new RegExp(`\\$\\('${id}'\\)\\.textContent=money`));
  });
});

describe('fotos: renovação sem recarregar a TV', () => {
  it('guarda a imagem pela identidade do arquivo (URL sem token) e reaproveita', () => {
    expect(app).toMatch(/const chaveFoto=url=>url\.split\('\?'\)\[0\]/);
    expect(app).toMatch(/img\.src=guardada\|\|url/);
  });
  it('se a cópia guardada falhar (token vencido), tenta a URL nova antes das iniciais', () => {
    expect(app).toMatch(/if\(img\.src!==url\)\{fotoCache\.delete\(k\);img\.src=url;return;\}/);
  });
  it('pódio redesenha quando uma foto passa a existir, sem depender da URL que muda a cada leitura', () => {
    expect(app).toMatch(/x=>x&&\[x\.nome,!!D\.fotoSegura\(x\.foto\)\]/);
  });
  it('pré-carrega as fotos a cada leitura da tv-dados', () => {
    expect(app).toMatch(/preCarregarFotos\(data\.destaques\);renderResults\(\)/);
  });
  it('foto é casada por ID na tv-dados, nunca por nome', () => {
    const edge = readFileSync(join(pasta, '..', 'supabase', 'functions', 'tv-dados', 'index.ts'), 'utf8');
    expect(edge).toMatch(/fotos\[id\]/);
    expect(edge).toMatch(/usuario_ids: ids/);
    expect(edge).not.toMatch(/fotos\[.*nome.*\]/);
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
