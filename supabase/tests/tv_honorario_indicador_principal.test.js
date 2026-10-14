// A MIGRATION 20261014113000 RODA DE VERDADE, num Postgres descartavel (PGlite).
//
// Por que este arquivo existe: teste de tela com snapshot dublado nao prova que
// o SQL funciona. Aqui `tv_snapshot_calcular()` e criada com o MESMO texto que
// esta versionado em 20260811220000 (a definicao completa que produçao recebeu),
// a migration e aplicada em cima pelo seu proprio mecanismo -- pg_get_functiondef
// + replace ancorado -- e a funcao e CHAMADA. Se uma ancora nao casar, se o
// plpgsql nao compilar ou se o payload sair errado, quebra aqui.
//
// NAO fala com producao, nao usa credencial e nao tem segredo: o banco nasce e
// morre dentro do teste. Dados FICTICIOS.
//
// A outra metade da compatibilidade e estatica e esta no ultimo describe: as
// ancoras tem de aparecer exatamente uma vez no texto versionado E nenhuma
// migration posterior pode ter tocado nelas. Juntas, as duas metades cobrem a
// pergunta "o patch casa com o corpo VIVO?" sem precisar abrir o banco de
// producao.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGS = resolve(RAIZ, "supabase", "migrations");
const ler = (n) => readFileSync(resolve(MIGS, `${n}.sql`), "utf8");

const BASE = "20260811220000_tv_magic_number_comparativo_mes_anterior";
const ESTA = "20261014113000_tv_honorario_indicador_principal";
const ETAPA3 = "20260731170000_tv_snapshot_etapa3";

// Esqueleto minimo do que a funcao LE. Nao e o schema de producao: e o
// suficiente para a funcao compilar e rodar. Tipos permissivos de proposito --
// o que esta sob teste e o SQL da migration, nao o DDL do projeto.
const ESQUELETO = `
create table public.pagamentos (
  id bigserial primary key, data_pagamento date, valor_pago numeric, valor_honorario numeric,
  operador_nome text, operador_email text, cpf text, aluno_nome text);
create table public.tv_projecao_snapshot (
  dia date primary key, recuperado_mes bigint, honorarios_mes bigint,
  proj_recuperado bigint, proj_honorarios bigint, atualizado_em timestamptz);
create table public.metas_projecao (
  mes_referencia text primary key, meta_honorario numeric, meta_operacional numeric, meta_unidades numeric,
  m1_percentual numeric, m1_valor numeric, m2_percentual numeric, m2_valor numeric,
  m3_percentual numeric, m3_valor numeric, m4_percentual numeric, m4_valor numeric);
create table public.usuarios (id bigserial primary key, nome text, email text, apelido text, perfil text, ativo boolean);
create table public.aluno_movimentacoes (
  id bigserial primary key, tipo text, status_novo text, registrado_por_email text, registrado_por_nome text,
  registrado_em timestamptz, elogio_aprovado_tv boolean, elogio_print_path text);
create table public.tv_dicas (id bigserial primary key, categoria text, titulo text, texto text, ordem int, ativo boolean);
create table public.tv_aniversariantes (id bigserial primary key, nome text, dia int, mes int, ativo boolean);
create table public.tv_mensagem_especial (
  id bigserial primary key, titulo text, texto text, ativo boolean, prioridade int,
  data_inicial date, data_final date, atualizado_em timestamptz);
create table public.tv_config (chave text primary key, ativo boolean, valor jsonb);
create function public.eh_tipo_acionamento(p_tipo text) returns boolean
  language sql immutable as $$ select coalesce(p_tipo,'') = 'LIGACAO' $$;
`;

// Pagamentos de hoje, ficticios. O par que decide o teste:
//   DIRETO  -> maior valor_pago do dia (90.000) e honorario ZERO. Nao pode
//              aparecer em destaque nenhum, mas tem de somar no bruto.
//   NATALY  -> menor valor_pago (50.000) e o MAIOR honorario (10.000).
// Se o criterio fosse bruto, DIRETO ganharia tudo. E o que se afirma abaixo.
const HOJE = [
  ["NATALY", "cobranca05@aelbra.com.br", 50000, 10000],
  ["NATALY", "cobranca05@aelbra.com.br", 12000, 2000],
  ["JOAO", "cobranca06@aelbra.com.br", 60000, 6000],
  ["JOAO", "cobranca06@aelbra.com.br", 8000, 800],
  ["JOAO", "cobranca06@aelbra.com.br", 7000, 700],
  ["DIRETO", "cobranca08@aelbra.com.br", 90000, 0],
];

let payload, fonteBase;

beforeAll(async () => {
  fonteBase = ler(BASE);
  const db = new PGlite();
  await db.exec(ESQUELETO);
  // helpers de meta (mesmo texto versionado) + a definicao completa da funcao
  const etapa3 = ler(ETAPA3);
  const i = etapa3.indexOf("create or replace function public._tv_meta_obj(");
  await db.exec(etapa3.slice(i, etapa3.indexOf("revoke all on function public._tv_meta_obj")));
  await db.exec(fonteBase);

  // A MIGRATION SOB TESTE, pelo seu proprio mecanismo ancorado.
  await db.exec(ler(ESTA));

  await db.query("insert into public.metas_projecao (mes_referencia, meta_honorario) values (to_char(current_date,'YYYY-MM'), 200000)");
  for (const [nome, email, pago, hon] of HOJE) {
    await db.query(
      "insert into public.pagamentos (data_pagamento, valor_pago, valor_honorario, operador_nome, operador_email, cpf) values (current_date, $1, $2, $3, $4, $5)",
      [pago, hon, nome, email, String(10000000000 + pago)]);
  }
  payload = (await db.query("select public.tv_snapshot_calcular() p")).rows[0].p;
  await db.close();
});

describe("a migration aplica e a funcao continua rodando", () => {
  it("o payload sai inteiro: nenhuma chave antiga desapareceu", () => {
    for (const k of ["dados", "proj", "rank", "dicas", "elogios", "aniversariantes", "hoje", "mes", "metas", "premiacao", "rankings", "julho_historico", "avisos"]) {
      expect(payload[k], `chave ${k}`).not.toBeUndefined();
    }
  });
});

describe("hoje.maior_pagamento — honorario no objeto e como criterio", () => {
  it("traz o honorario do pagamento, junto do bruto", () => {
    expect(payload.hoje.maior_pagamento).toMatchObject({ operador: "NATALY", honorario: 10000, valor: 50000 });
  });

  it("o pagamento DIRETO, sem honorario, nao e eleito — mesmo sendo o maior bruto do dia", () => {
    expect(payload.hoje.maior_pagamento.operador).not.toBe("DIRETO");
  });

  it("mas o DIRETO continua somando no bruto do dia (ele e dinheiro recuperado)", () => {
    const bruto = HOJE.reduce((s, [, , p]) => s + p, 0);
    const hon = HOJE.reduce((s, [, , , h]) => s + h, 0);
    expect(payload.hoje.recuperado).toBe(bruto);
    expect(payload.hoje.honorarios).toBe(hon);
  });
});

describe("rankings — criterio e honorario recebido por operador", () => {
  it("melhor do dia e do mes e quem trouxe mais honorario, com o valor", () => {
    // por bruto, JOAO (75.000) ganharia de NATALY (62.000); por honorario, NATALY
    // (12.000) ganha de JOAO (7.500). O ranking tem de dizer NATALY.
    expect(payload.rankings.melhor_dia).toEqual({ operador: "NATALY", honorario: 12000 });
    expect(payload.rankings.melhor_mes).toEqual({ operador: "NATALY", honorario: 12000 });
  });

  it("top3 do mes vem ordenado por honorario e sem quem nao trouxe honorario", () => {
    expect(payload.rankings.top3_mes).toEqual([
      { operador: "NATALY", honorario: 12000 },
      { operador: "JOAO", honorario: 7500 },
    ]);
    expect(JSON.stringify(payload.rankings.top3_mes)).not.toContain("DIRETO");
  });

  it("maior pagamento do mes traz honorario e nao e o pagamento sem honorario", () => {
    expect(payload.rankings.maior_pagamento_mes).toMatchObject({ operador: "NATALY", honorario: 10000, valor: 50000 });
  });

  it("mais pagamentos do dia continua sendo por QUANTIDADE, como era", () => {
    expect(payload.rankings.mais_pagos_dia).toEqual({ operador: "JOAO", qtd: 3 });
  });
});

describe("mes.media_diaria_honorarios — chave nova, a de bruto intocada", () => {
  it("as duas chaves coexistem e sao numeros diferentes", () => {
    const du = payload.mes.dias_uteis_transcorridos;
    expect(payload.mes.media_diaria_honorarios).toBe(Math.round(payload.mes.honorarios / du));
    expect(payload.mes.media_diaria).toBe(Math.round(payload.mes.recuperado / du));
    expect(payload.mes.media_diaria).not.toBe(payload.mes.media_diaria_honorarios);
  });

  it("meta, percentual, falta e necessario por dia seguem em honorario, como ja eram", () => {
    expect(payload.mes.meta_empresa).toBe(200000);
    expect(payload.mes.meta_pct).toBe(Number((payload.mes.honorarios / 200000 * 100).toFixed(1)));
    expect(payload.mes.meta_falta).toBe(200000 - payload.mes.honorarios);
  });
});

describe("aplicar duas vezes e inofensivo", () => {
  it("a segunda aplicacao nao erra e nao muda o payload", async () => {
    const db = new PGlite();
    await db.exec(ESQUELETO);
    const etapa3 = ler(ETAPA3);
    const i = etapa3.indexOf("create or replace function public._tv_meta_obj(");
    await db.exec(etapa3.slice(i, etapa3.indexOf("revoke all on function public._tv_meta_obj")));
    await db.exec(fonteBase);
    await db.exec(ler(ESTA));
    const um = (await db.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tv_snapshot_calcular'")).rows[0].d;
    await db.exec(ler(ESTA)); // de novo
    const dois = (await db.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tv_snapshot_calcular'")).rows[0].d;
    expect(dois).toBe(um);
    await db.close();
  });
});

describe("o rollback devolve a funcao ao formato antigo", () => {
  it("desfaz as tres chaves e a funcao volta a rodar", async () => {
    const db = new PGlite();
    await db.exec(ESQUELETO);
    const etapa3 = ler(ETAPA3);
    const i = etapa3.indexOf("create or replace function public._tv_meta_obj(");
    await db.exec(etapa3.slice(i, etapa3.indexOf("revoke all on function public._tv_meta_obj")));
    await db.exec(fonteBase);
    await db.exec(ler(ESTA));
    await db.exec(readFileSync(resolve(RAIZ, "supabase", "rollbacks", `${ESTA}.rollback.sql`), "utf8"));
    await db.query("insert into public.pagamentos (data_pagamento, valor_pago, valor_honorario, operador_nome, operador_email) values (current_date, 50000, 10000, 'NATALY', 'cobranca05@aelbra.com.br')");
    const p = (await db.query("select public.tv_snapshot_calcular() p")).rows[0].p;
    expect(p.hoje.maior_pagamento.honorario).toBeUndefined();
    expect(p.mes.media_diaria_honorarios).toBeUndefined();
    expect(p.rankings.melhor_mes).toEqual({ operador: "NATALY" });
    expect(p.mes.media_diaria).not.toBeUndefined(); // a de bruto nunca saiu
    await db.close();
  });
});

describe("a pre-validacao somente-leitura responde certo nos dois estados", () => {
  // supabase/audits/tv_honorario_prevalidacao_20261014.sql e o que vai rodar em
  // producao antes de aplicar. Ele carrega as ancoras em copia, para poder ser
  // colado num SQL editor sem o repositorio a mao -- e por isso tem de ser
  // exercitado: uma copia defasada daria "AUSENTE" num banco saudavel e
  // pararia a aplicacao sem motivo.
  const AUDIT = () => readFileSync(resolve(RAIZ, "supabase", "audits", "tv_honorario_prevalidacao_20261014.sql"), "utf8");

  const preparar = async (aplicar) => {
    const db = new PGlite();
    await db.exec(ESQUELETO);
    const etapa3 = ler(ETAPA3);
    const i = etapa3.indexOf("create or replace function public._tv_meta_obj(");
    await db.exec(etapa3.slice(i, etapa3.indexOf("revoke all on function public._tv_meta_obj")));
    await db.exec(fonteBase);
    if (aplicar) await db.exec(ler(ESTA));
    return db;
  };
  // O arquivo tem um SELECT e, depois, comentarios. `query` roda uma instrucao:
  // corta no primeiro ponto-e-virgula de fim de instrucao.
  const consulta = () => AUDIT().slice(0, AUDIT().indexOf("order by ordem;") + "order by ordem;".length);

  it("antes de aplicar: as tres ancoras OK e o resumo PRONTO PARA APLICAR", async () => {
    const db = await preparar(false);
    const r = (await db.query(consulta())).rows;
    expect(r.filter((x) => x.veredito.startsWith("OK"))).toHaveLength(3);
    expect(r.find((x) => x.ordem === "resumo").veredito).toBe("PRONTO PARA APLICAR");
    await db.close();
  });

  it("depois de aplicar: as tres dizem JA APLICADO e o resumo segue liberado", async () => {
    const db = await preparar(true);
    const r = (await db.query(consulta())).rows;
    expect(r.filter((x) => x.veredito.startsWith("JA APLICADO"))).toHaveLength(3);
    expect(r.find((x) => x.ordem === "resumo").veredito).toBe("PRONTO PARA APLICAR");
    await db.close();
  });

  it("corpo divergente: acusa AUSENTE e manda NAO APLICAR", async () => {
    const db = await preparar(false);
    // simula o que a pre-validacao existe para pegar: alguem patchou a funcao
    // por outra frente e a ancora nao existe mais com aquele texto.
    const src = (await db.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tv_snapshot_calcular'")).rows[0].d;
    await db.exec(src.replace("'media_diaria', v_media_dia, 'projecao_fechamento', v_proj_fech,", "'media_diaria', v_media_dia,\n    'projecao_fechamento', v_proj_fech,"));
    const r = (await db.query(consulta())).rows;
    expect(r.find((x) => x.nome === "media_diaria_honorarios").veredito).toMatch(/^AUSENTE/);
    expect(r.find((x) => x.ordem === "resumo").veredito).toBe("NAO APLICAR - ver as linhas acima");
    await db.close();
  });
});

describe("compatibilidade com o corpo VIVO (estatica)", () => {
  // As ancoras do patch sao lidas do proprio arquivo da migration, nos blocos
  // `v_de text := $a$...$a$`. Nao ha lista duplicada para sair de sincronia.
  const ancoras = [...ler(ESTA).matchAll(/ {2}v_de {3}text := \$a\$([\s\S]*?)\$a\$;\n/g)].map((m) => m[1]);

  it("sao tres ancoras, e cada uma aparece exatamente uma vez no texto versionado", () => {
    expect(ancoras).toHaveLength(3);
    for (const a of ancoras) {
      expect(fonteBase.split(a).length - 1, `ancora:\n${a.slice(0, 80)}`).toBe(1);
    }
  });

  it("nenhuma migration POSTERIOR a 20260811220000 tocou nessas ancoras", () => {
    // Se alguma tocou, o corpo vivo divergiu do versionado e o patch casaria
    // com o texto errado -- ou (pior) com nada, abortando so em producao.
    const posteriores = readdirSync(MIGS)
      .filter((f) => f.endsWith(".sql") && f.slice(0, 14) > BASE.slice(0, 14) && !f.startsWith(ESTA.slice(0, 14)));
    const culpadas = [];
    for (const f of posteriores) {
      const t = readFileSync(resolve(MIGS, f), "utf8");
      for (const a of ancoras) {
        // trecho curto e caracteristico de cada ancora: comparar a ancora
        // inteira nao acharia uma alteracao PARCIAL dela.
        for (const pedaco of a.split("\n").map((l) => l.trim()).filter((l) => l.length > 40)) {
          if (t.includes(pedaco)) culpadas.push(`${f} :: ${pedaco.slice(0, 60)}`);
        }
      }
    }
    expect(culpadas).toEqual([]);
  });
});
