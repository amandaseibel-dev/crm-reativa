// SAÍDA TERMINAL PARA A PENDÊNCIA DECIDIDA SEM EFEITO FINANCEIRO — PostgreSQL real
// (PGlite). Roda a MIGRATION REAL (20261024170000) e o ROLLBACK REAL.
//
// ESCOPO DECLARADO, para não haver dúvida sobre o que está provado:
//
//   Prova-se que a transição só acontece com as TRÊS provas presentes (decisão
//   na allowlist, nenhuma parcela apontando, auditoria da decisão como sem
//   efeito financeiro), que o portão recusa operador e identidade nula, que a
//   função é idempotente, que NADA de parcela/acordo/baixa/saldo se move, e que
//   os indicadores fecham: a triagem deixa de ver o encerrado, a conferência
//   por arquivo continua fechando com o total do arquivo, e o contador
//   `pendentes` da rodada cai exatamente pelo número movido.
//
//   Prova-se também que o patch ancorado cai no CONTADOR e não na SELEÇÃO do
//   lote -- a diferença entre mexer num número e mexer no comportamento da
//   rodada.
//
//   NÃO se prova que a produção tem os números do cabeçalho da migration: a
//   base é sintética. As medições de 24/10/2026 estão lá, com as consultas, e
//   em docs/CONCILIACAO-INTELIGENTE-2026-10-24.md.
//
//   NÃO se prova regra financeira nova, porque não há nenhuma: a única escrita
//   em dado é uma coluna de controle de conciliação.
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que
// a executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const BANCADA = ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.sql");
const MD5 = JSON.parse(ler("supabase/tests/fixtures/fluxo_incremental_prod_20261021.md5.json"));
const CENARIO_ARQUIVO = ler("supabase/tests/fixtures/importacao_conferencia_cenario.sql");
const CENARIO_TERMINAL = ler("supabase/tests/fixtures/saida_terminal_cenario.sql");

const MIG_RODADA = ler("supabase/migrations/20261021195950_fluxo_pagamentos_incremental.sql");
const MIG_PERM = ler("supabase/migrations/20261021210208_vw_fluxo_monitor_fecha_escrita.sql");
const MIG_PREVIA = ler("supabase/migrations/20261021210416_fluxo_incremental_previa_sem_escrita.sql");
const MIG_ESPERA = ler("supabase/migrations/20261021223117_fluxo_incremental_espera_nao_exclui.sql");
const MIG_TRIAGEM = ler("supabase/migrations/20261023000700_fila_pagamento_triagem.sql");
// A RESERVA da #738 NÃO está em produção (conferido em `schema_migrations` em
// 24/10/2026: a versão 20261023004500 não existe lá). Ela reescreve o corpo
// INTEIRO da rodada, então aplicá-la aqui afastaria a bancada do corpo vivo. Ela
// entra apenas no teste de interação, no fim deste arquivo.
const MIG_RESERVA = ler("supabase/migrations/20261023004500_fluxo_incremental_reserva_bloqueado.sql");
const MIG_CONFERENCIA = ler("supabase/migrations/20261023164204_importacao_conferencia_por_arquivo.sql");
const MIGRATION = ler("supabase/migrations/20261024170000_conciliacao_saida_terminal.sql");
const ROLLBACK = ler("supabase/rollbacks/20261024170000_conciliacao_saida_terminal.rollback.sql");

// `begin;`/`commit;` conflitam com o controle de transação do db.exec do PGlite.
const semTransacao = (sql) =>
  sql.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

// O CORPO VIVO DA RODADA EM PRODUÇÃO, colhido em 24/10/2026 em
// `ahattpqrjmhkzsmnbdzs`. O mesmo valor que `fluxo_incremental_reserva_bloqueado`
// já fixa: se o repositório divergir do que está rodando, esta frente está
// construindo sobre o chão errado e o teste acusa ANTES de qualquer outra coisa.
const MD5_RODADA_PROD = "11c14ef5bcbc4283357de8ef2d798c5e";

const GESTAO = "amanda.seibel@aelbra.com.br";
const OPERADOR = "cobranca05@aelbra.com.br";

const T = (n) => `ee00000${n}-0000-0000-0000-00000000000${n}`;
const ELEGIVEIS = [T(1), T(2)];
const TERMINAL = "ENCERRADO_SEM_EFEITO_FINANCEIRO";
const ARQ_A = "aaaaaaaa-0000-0000-0000-00000000000a";

let db;
let dump;

const linhas = async (sql, p = []) => (await db.query(sql, p)).rows;
const uma = async (sql, p = []) => (await linhas(sql, p))[0];

const comoGestao = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${GESTAO}"}', false),
                  set_config('request.jwt.claim.role', '', false)`);
const comoOperador = () =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${OPERADOR}"}', false),
                  set_config('request.jwt.claim.role', '', false)`);
const semIdentidade = () =>
  db.exec(`select set_config('request.jwt.claims', '{}', false),
                  set_config('request.jwt.claim.role', '', false)`);
const comoRotina = () =>
  db.exec(`select set_config('request.jwt.claims', '{}', false),
                  set_config('request.jwt.claim.role', 'service_role', false)`);

const encerrar = async (id, confirmar) =>
  (await uma(
    `select public.conciliacao_encerrar_sem_efeito_financeiro($1::uuid, $2) j`,
    [id, confirmar]
  )).j;

const statusDe = async (id) =>
  (await uma(`select status_conciliacao s from public.pagamentos where id = $1::uuid`, [id])).s;

// A FOTOGRAFIA DO DINHEIRO. Contagem E soma: contagem sozinha não pegaria um
// UPDATE de valor, soma sozinha não pegaria um par de linhas que se anula.
const fotoDoDinheiro = async () =>
  await uma(`
    select (select count(*) from public.parcelas) parcelas_n,
           (select coalesce(sum(valor),0) from public.parcelas) parcelas_v,
           (select count(*) from public.parcelas where status = 'PAGO') parcelas_pago,
           (select count(*) from public.parcelas where origem_baixa_ref is not null) parcelas_ref,
           (select count(*) from public.acordos) acordos_n,
           (select coalesce(sum(saldo),0) from public.acordos) acordos_v,
           (select count(*) from public.baixas_pagamento) baixas_n,
           (select coalesce(sum(valor_pago),0) from public.baixas_pagamento) baixas_v,
           (select coalesce(sum(saldo_total),0) from public.alunos) saldo,
           (select coalesce(sum(valor_pago),0) from public.pagamentos) pago_total,
           (select count(*) from public.pagamentos) pagamentos_n`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BANCADA);

  // PORTÃO DE FIDELIDADE: corpo de produção divergente para aqui.
  const rows = await linhas(
    `select 'public.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`
  );
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, esperado] of Object.entries(MD5)) {
    if (noBanco[nome] !== esperado) {
      throw new Error(`fixture diverge de producao em ${nome}: ${noBanco[nome]} != ${esperado}`);
    }
  }

  // O cenário do arquivo vem ANTES da triagem: ele acrescenta as colunas que a
  // view da #737 lê (`titulo_numero`) e que a bancada base não tem.
  await db.exec(CENARIO_ARQUIVO);
  await db.exec(CENARIO_TERMINAL);
  await comoGestao();

  // A rodada, na ordem em que produção a construiu.
  for (const m of [MIG_RODADA, MIG_PERM, MIG_PREVIA, MIG_ESPERA]) {
    await db.exec(semTransacao(m));
  }
  await db.exec(semTransacao(MIG_TRIAGEM));
  await db.exec(semTransacao(MIG_CONFERENCIA));

  // O DUBLÊ NÃO RESOLVE NADA, de propósito: devolve a cada pagamento o status
  // que ele já tem. Assim nenhuma pendência sai da fila por efeito do teste, e
  // o que sobra de observável é exatamente o CONTADOR.
  await db.exec(`
    insert into public._dub_motor (pagamento_id, status, baixou)
    select p.id, p.status_conciliacao, false
      from public.pagamentos p
     where p.status_conciliacao is not null
       on conflict (pagamento_id) do nothing;`);

  dump = await db.dumpDataDir();
});

// Cada bloco que ESCREVE parte de um banco limpo, para não herdar efeito do
// anterior: a ordem dos testes não pode mudar o resultado.
const bancoLimpo = async () => {
  if (db) await db.close();
  db = new PGlite({ loadDataDir: dump });
  await comoGestao();
};

describe("antes de tudo: a rodada em teste é a de produção", () => {
  it("md5(prosrc) de fluxo_pagamentos_incremental bate com produção", async () => {
    const r = await uma(
      `select md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(r.md5).toBe(MD5_RODADA_PROD);
  });

  it("a ancora do patch aparece exatamente uma vez no corpo vivo", async () => {
    const r = await uma(
      `select (length(p.prosrc) - length(replace(p.prosrc, $a$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';$a$, '')))
              / length($a$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';$a$) n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(r.n)).toBe(1);
  });
});

describe("a migration aplica e os sete portoes fecham", () => {
  beforeAll(async () => {
    await bancoLimpo();
    await db.exec(semTransacao(MIGRATION));
    dump = await db.dumpDataDir();
  });

  it("a funcao existe, SECURITY DEFINER e com search_path", async () => {
    const r = await uma(
      `select p.prosecdef sd, array_to_string(coalesce(p.proconfig,'{}'), ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'conciliacao_encerrar_sem_efeito_financeiro'`
    );
    expect(r.sd).toBe(true);
    expect(r.cfg).toMatch(/search_path/);
  });

  it("a migration nao moveu pagamento nenhum", async () => {
    const r = await uma(
      `select (select count(*) from public.pagamentos where status_conciliacao = $1) terminais,
              (select count(*) from public.auditoria where acao = 'CONCILIACAO_SAIDA_TERMINAL') trilha`,
      [TERMINAL]
    );
    expect(Number(r.terminais)).toBe(0);
    expect(Number(r.trilha)).toBe(0);
  });
});

describe("permissoes: a porta recusa quem nao e gestao", () => {
  beforeAll(bancoLimpo);

  it("operador recebe 42501 e nada muda", async () => {
    await comoOperador();
    await expect(encerrar(T(1), true)).rejects.toThrow(/42501|decisao da gestao/i);
    await comoGestao();
    expect(await statusDe(T(1))).toBe("REVISAO");
  });

  it("identidade NULA recebe 42501 -- `NULL and ...` nao abre a porta", async () => {
    await semIdentidade();
    await expect(encerrar(T(1), true)).rejects.toThrow(/42501|decisao da gestao/i);
    await comoGestao();
    expect(await statusDe(T(1))).toBe("REVISAO");
  });

  it("gestao passa", async () => {
    await comoGestao();
    expect((await encerrar(T(1), false)).ok).toBe(true);
  });

  it("a rotina (service_role) passa sem e-mail nenhum", async () => {
    await comoRotina();
    expect((await encerrar(T(1), false)).ok).toBe(true);
    await comoGestao();
  });
});

describe("a previa nao grava", () => {
  beforeAll(bancoLimpo);

  it("sem p_confirmar devolve SIMULACAO e o status fica igual", async () => {
    const r = await encerrar(T(1), false);
    expect(r.modo).toBe("SIMULACAO");
    expect(r.gravou).toBe(false);
    expect(r.aprovado).toBe(true);
    expect(r.status_proposto).toBe(TERMINAL);
    expect(await statusDe(T(1))).toBe("REVISAO");
  });

  it("a previa nao deixa rastro de transicao na auditoria", async () => {
    await encerrar(T(1), false);
    const r = await uma(
      `select count(*) n from public.auditoria where acao = 'CONCILIACAO_SAIDA_TERMINAL'`
    );
    expect(Number(r.n)).toBe(0);
  });

  it("a previa devolve o estado anterior, com a decisao que a autoriza", async () => {
    const r = await encerrar(T(1), false);
    expect(r.estado_anterior.status_conciliacao).toBe("REVISAO");
    expect(r.estado_anterior.fila.decisao).toBe("FEITO");
    // o motivo da pendencia original volta na previa: e o historico
    expect(r.estado_anterior.fila.motivo).toMatch(/PAGO antes/);
  });
});

describe("o caminho feliz, e a idempotencia", () => {
  beforeAll(bancoLimpo);

  it("confirma, move o status e deixa UMA linha de auditoria", async () => {
    const r = await encerrar(T(1), true);
    expect(r.ok).toBe(true);
    expect(r.modo).toBe("CONFIRMADO");
    expect(r.gravou).toBe(true);
    expect(r.status_conciliacao).toBe(TERMINAL);
    expect(await statusDe(T(1))).toBe(TERMINAL);

    const a = await uma(
      `select count(*) n, min(detalhes ->> 'decisao_que_autorizou') dec,
              min(detalhes -> 'estado_anterior' ->> 'status_conciliacao') antes,
              bool_and((detalhes ->> 'sem_efeito_financeiro')::boolean) sem_efeito,
              min(usuario) quem
         from public.auditoria
        where acao = 'CONCILIACAO_SAIDA_TERMINAL' and registro_id = $1::uuid`,
      [T(1)]
    );
    expect(Number(a.n)).toBe(1);
    expect(a.dec).toBe("FEITO");
    expect(a.antes).toBe("REVISAO");
    expect(a.sem_efeito).toBe(true);
    expect(a.quem).toBe(GESTAO);
  });

  it("a segunda chamada devolve JA_ENCERRADO, nao grava e nao audita de novo", async () => {
    const r = await encerrar(T(1), true);
    expect(r.ok).toBe(true);
    expect(r.motivo).toBe("JA_ENCERRADO");
    expect(r.gravou).toBe(false);

    const a = await uma(
      `select count(*) n from public.auditoria
        where acao = 'CONCILIACAO_SAIDA_TERMINAL' and registro_id = $1::uuid`,
      [T(1)]
    );
    expect(Number(a.n)).toBe(1);
  });

  it("o conciliacao_motivo original NAO e sobrescrito -- e historico", async () => {
    const r = await uma(
      `select conciliacao_motivo m from public.pagamentos where id = $1::uuid`, [T(1)]
    );
    expect(r.m).toBe("parcela ja estava PAGO antes");
  });

  it("a decisao na fila fica intacta: a transicao nao mexe na fila", async () => {
    const r = await uma(
      `select decisao, conclusao, decidido_por, decidido_em
         from public.fila_pagamento_sem_vinculo where pagamento_id = $1::uuid`, [T(1)]
    );
    expect(r.decisao).toBe("FEITO");
    expect(r.conclusao).toBe("PARCELA_JA_PAGA_CONFERIDA");
    expect(r.decidido_por).toBe(GESTAO);
    expect(r.decidido_em).not.toBeNull();
  });
});

describe("as seis recusas, cada uma com motivo nomeado", () => {
  beforeAll(bancoLimpo);

  const recusa = async (id, motivo) => {
    const r = await encerrar(id, true);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe(motivo);
    expect(r.gravou).toBe(false);
    return r;
  };

  it("T3 -- decisao SEM auditoria de decisao sem efeito financeiro", async () => {
    const antes = await statusDe(T(3));
    await recusa(T(3), "SEM_PROVA_DE_DECISAO_SEM_EFEITO");
    expect(await statusDe(T(3))).toBe(antes);
  });

  it("T4 -- tem parcela apontando: o destino dele e BAIXADO, nao o terminal", async () => {
    const r = await recusa(T(4), "TEM_BAIXA_REGISTRADA");
    expect(r.parcela_id).toBe("ee0f0004-0000-0000-0000-000000000004");
    expect(await statusDe(T(4))).toBe("REVISAO");
  });

  it("T5 -- fila ABERTA: a auditoria sozinha nao abre a porta", async () => {
    await recusa(T(5), "SEM_DECISAO_VALIDA");
    expect(await statusDe(T(5))).toBe("REVISAO");
  });

  it("T6 -- decisao fora da allowlist (o que `decisao is not null` deixaria passar)", async () => {
    const r = await recusa(T(6), "DECISAO_FORA_DA_ALLOWLIST");
    expect(r.decisao).toBe("REPROCESSAR");
    expect(await statusDe(T(6))).toBe("REVISAO");
  });

  it("T7 -- status nulo: a fronteira de 14/09 e da gestao, nao desta funcao", async () => {
    await recusa(T(7), "FORA_DA_JANELA");
    expect(await statusDe(T(7))).toBeNull();
  });

  it("T8 -- BAIXADO nao vira terminal", async () => {
    await recusa(T(8), "JA_BAIXADO");
    expect(await statusDe(T(8))).toBe("BAIXADO");
  });

  it("pagamento inexistente nao estoura", async () => {
    const r = await encerrar("00000000-0000-0000-0000-0000000000ff", true);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("PAGAMENTO_NAO_ENCONTRADO");
  });

  it("nenhuma das recusas deixou rastro de transicao", async () => {
    const r = await uma(
      `select count(*) n from public.auditoria where acao = 'CONCILIACAO_SAIDA_TERMINAL'`
    );
    expect(Number(r.n)).toBe(0);
  });
});

describe("nada de dinheiro se move", () => {
  beforeAll(bancoLimpo);

  it("parcela, acordo, baixa, saldo e valor pago ficam identicos", async () => {
    const antes = await fotoDoDinheiro();
    for (const id of ELEGIVEIS) {
      expect((await encerrar(id, true)).gravou).toBe(true);
    }
    const depois = await fotoDoDinheiro();
    expect(depois).toEqual(antes);
  });

  it("o unico campo que mudou em pagamentos foi status_conciliacao", async () => {
    // Soma de tudo o que a fotografia nao cobre, por pagamento movido.
    const r = await uma(
      `select count(*) filter (where conciliacao_motivo is distinct from 'parcela ja estava PAGO antes'
                                 and id = $1::uuid) m1,
              count(*) filter (where origem_vinculo is not null and id = any($3::uuid[])) vinculo,
              count(*) filter (where aluno_id is not null and id = any($3::uuid[])) aluno
         from public.pagamentos where id = any($3::uuid[]) or id = $1::uuid or id = $2::uuid`,
      [ELEGIVEIS[0], ELEGIVEIS[1], ELEGIVEIS]
    );
    expect(Number(r.m1)).toBe(0);
    expect(Number(r.vinculo)).toBe(0);
    expect(Number(r.aluno)).toBe(0);
  });
});

describe("fechamento dos indicadores", () => {
  let pendentesAntes;

  beforeAll(async () => {
    await bancoLimpo();
    pendentesAntes = Number(
      (await uma(`select public.fluxo_pagamentos_incremental(25, 120, 8, 24, false) j`))
        .j.pendentes
    );
    for (const id of ELEGIVEIS) await encerrar(id, true);
  });

  it("a triagem nao devolve mais os encerrados", async () => {
    const r = await uma(
      `select count(*) n from public.vw_fila_pagamento_triagem
        where pagamento_id = any($1::uuid[])`, [ELEGIVEIS]
    );
    expect(Number(r.n)).toBe(0);
  });

  it("e nenhuma linha da triagem tem o status terminal", async () => {
    const r = await uma(
      `select count(*) n from public.vw_fila_pagamento_triagem where status_conciliacao = $1`,
      [TERMINAL]
    );
    expect(Number(r.n)).toBe(0);
  });

  it("a subcategoria decidida_mas_ainda_pendente nao conta quem ja tem saida", async () => {
    const r = await uma(
      `select count(*) n from public.vw_fila_pagamento_triagem
        where subcategoria = 'decidida_mas_ainda_pendente' and pagamento_id = any($1::uuid[])`,
      [ELEGIVEIS]
    );
    expect(Number(r.n)).toBe(0);
  });

  it("a conferencia por arquivo MANTEM o pagamento, com categoria propria", async () => {
    const r = await linhas(
      `select pagamento_id, categoria, triagem_categoria, triagem_motivo
         from public.vw_importacao_conferencia
        where pagamento_id = any($1::uuid[]) order by pagamento_id`, [ELEGIVEIS]
    );
    expect(r.length).toBe(2);
    for (const l of r) {
      expect(l.categoria).toBe(TERMINAL);
      // saiu da triagem: a categoria da triagem fica nula, de propósito
      expect(l.triagem_categoria).toBeNull();
      // mas o MOTIVO da pendência original sobrevive, pelo recuo para a fila
      expect(l.triagem_motivo).not.toBeNull();
    }
  });

  it("o recuo do motivo NAO vaza para outra categoria", async () => {
    // P2 é BAIXA_REGISTRADA_CRM com linha de fila já resolvida (os 246 de
    // produção). Ele tem `f.motivo` preenchido e continua com motivo nulo: o
    // recuo é só do terminal.
    const r = await uma(
      `select categoria, triagem_motivo from public.vw_importacao_conferencia
        where pagamento_id = '22222222-0000-0000-0000-000000000002'::uuid`
    );
    expect(r.categoria).toBe("BAIXA_REGISTRADA_CRM");
    expect(r.triagem_motivo).toBeNull();
  });

  it("as categorias continuam fechando com o total do arquivo", async () => {
    const r = await uma(
      `with v as (select * from public.vw_importacao_conferencia where importacao_id = $1::uuid)
       select (select count(*) from v) total,
              (select count(*) from v where categoria is not null) com_categoria,
              (select count(distinct pagamento_id) from v) distintos,
              (select coalesce(sum(valor_pago),0) from v) soma_view,
              (select coalesce(sum(valor_pago),0) from public.pagamentos
                where importacao_id = $1::uuid) soma_tabela,
              (select count(*) from v where categoria = 'NAO_CLASSIFICADO') residuo`,
      [ARQ_A]
    );
    expect(Number(r.total)).toBe(Number(r.com_categoria));
    expect(Number(r.total)).toBe(Number(r.distintos));
    expect(Number(r.soma_view)).toBe(Number(r.soma_tabela));
    expect(Number(r.residuo)).toBe(0);
  });

  it("nenhum pagamento aparece em duas categorias", async () => {
    const r = await uma(
      `select count(*) n from (
         select pagamento_id from public.vw_importacao_conferencia
          group by pagamento_id having count(*) > 1) x`
    );
    expect(Number(r.n)).toBe(0);
  });

  it("o contador `pendentes` da rodada cai exatamente pelos 2 movidos", async () => {
    const depois = Number(
      (await uma(`select public.fluxo_pagamentos_incremental(25, 120, 8, 24, false) j`))
        .j.pendentes
    );
    expect(depois).toBe(pendentesAntes - 2);
  });
});

describe("o CHECK continua sendo um CHECK", () => {
  beforeAll(bancoLimpo);

  it("aceita o valor terminal", async () => {
    await db.exec(
      `update public.pagamentos set status_conciliacao = '${TERMINAL}'
        where id = '${T(1)}'::uuid`
    );
    expect(await statusDe(T(1))).toBe(TERMINAL);
  });

  it("continua recusando um valor que nao existe", async () => {
    await expect(
      db.exec(`update public.pagamentos set status_conciliacao = 'INVENTADO'
                where id = '${T(2)}'::uuid`)
    ).rejects.toThrow(/pagamentos_status_conciliacao_valido|check/i);
  });

  it("os oito valores antigos seguem aceitos", async () => {
    for (const v of ["BAIXADO", "AGUARDANDO_ACORDO", "AGUARDANDO_AMARRACAO",
                     "PARCELA_JA_PAGA", "REVISAO", "SEM_VINCULO",
                     "ACORDO_CONFIRMADO_SEM_ESTRUTURA", "TITULO_ORIGINAL_LIQUIDADO"]) {
      await db.exec(`update public.pagamentos set status_conciliacao = '${v}'
                      where id = '${T(2)}'::uuid`);
      expect(await statusDe(T(2))).toBe(v);
    }
  });
});

describe("o patch ancorado: contador sim, selecao do lote nao", () => {
  beforeAll(bancoLimpo);

  it("o predicado novo entrou exatamente uma vez", async () => {
    const r = await uma(
      `select (length(p.prosrc) - length(replace(p.prosrc, $x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$, '')))
              / length($x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$) n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(r.n)).toBe(1);
  });

  it("ele esta DEPOIS do `select count(*) into v_pend` -- e o contador", async () => {
    const r = await uma(
      `select position($y$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$y$ in p.prosrc) pos_novo,
              position($y$select count(*) into v_pend$y$ in p.prosrc) pos_contador
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(r.pos_contador)).toBeGreaterThan(0);
    expect(Number(r.pos_novo)).toBeGreaterThan(Number(r.pos_contador));
  });

  it("a SELECAO do lote ficou intacta: segue sem o predicado novo", async () => {
    const r = await uma(
      `select substring(p.prosrc from 1 for position($y$select count(*) into v_pend$y$ in p.prosrc)) selecao
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(r.selecao).not.toMatch(/ENCERRADO_SEM_EFEITO_FINANCEIRO/);
    // e continua excluindo a linha decidida, que e o que torna a troca segura
    expect(r.selecao).toMatch(/d\.decisao is not null/);
  });

  it("reaplicar a migration nao duplica o predicado (idempotente)", async () => {
    await db.exec(semTransacao(MIGRATION));
    const r = await uma(
      `select (length(p.prosrc) - length(replace(p.prosrc, $x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$, '')))
              / length($x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$) n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(r.n)).toBe(1);
  });
});

describe("o rollback", () => {
  beforeAll(bancoLimpo);

  it("RECUSA enquanto houver alguem encerrado -- nao apaga decisao que vale", async () => {
    await encerrar(T(1), true);
    await expect(db.exec(semTransacao(ROLLBACK)))
      .rejects.toThrow(/ROLLBACK RECUSADO/i);
    expect(await statusDe(T(1))).toBe(TERMINAL);
  });

  it("depois de revertido o backfill, desfaz tudo", async () => {
    await bancoLimpo();
    await db.exec(semTransacao(ROLLBACK));

    const r = await uma(
      `select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname = 'conciliacao_encerrar_sem_efeito_financeiro') funcao,
              (select (length(p.prosrc) - length(replace(p.prosrc, 'ENCERRADO_SEM_EFEITO_FINANCEIRO', '')))
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental') rodada,
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = 'vw_importacao_conferencia'
                  and pg_get_viewdef(c.oid) like '%ENCERRADO\\_SEM\\_EFEITO\\_FINANCEIRO%') view_conf,
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = 'vw_fila_pagamento_triagem'
                  and pg_get_viewdef(c.oid) like '%ENCERRADO\\_SEM\\_EFEITO\\_FINANCEIRO%') view_triagem`
    );
    expect(Number(r.funcao)).toBe(0);
    expect(Number(r.rodada)).toBe(0);
    expect(Number(r.view_conf)).toBe(0);
    expect(Number(r.view_triagem)).toBe(0);
  });

  it("o CHECK volta aos oito valores e recusa o terminal", async () => {
    await expect(
      db.exec(`update public.pagamentos set status_conciliacao = '${TERMINAL}'
                where id = '${T(2)}'::uuid`)
    ).rejects.toThrow(/pagamentos_status_conciliacao_valido|check/i);
  });

  it("as duas views voltam a funcionar, e o arquivo continua fechando", async () => {
    const r = await uma(
      `with v as (select * from public.vw_importacao_conferencia where importacao_id = $1::uuid)
       select (select count(*) from v) total,
              (select count(*) from v where categoria = 'NAO_CLASSIFICADO') residuo,
              (select count(*) from public.vw_fila_pagamento_triagem) triagem`,
      [ARQ_A]
    );
    expect(Number(r.total)).toBeGreaterThan(0);
    expect(Number(r.residuo)).toBe(0);
    expect(Number(r.triagem)).toBeGreaterThan(0);
  });
});

// ===========================================================================
// A INTERAÇÃO COM A PR #738, que está ABERTA e não aplicada
// ===========================================================================
// A #738 (`20261023004500_fluxo_incremental_reserva_bloqueado`) reescreve o
// corpo INTEIRO de `fluxo_pagamentos_incremental` com `create or replace`. Se
// ela for aplicada DEPOIS desta migration, ela apaga o patch do contador -- em
// silêncio, porque nada falha. Este teste existe para que a ordem de aplicação
// seja uma decisão consciente e não uma surpresa.
describe("interacao com a #738 (reserva), ainda nao aplicada em producao", () => {
  beforeAll(bancoLimpo);

  it("aplicar a #738 DEPOIS desta migration remove o predicado do contador", async () => {
    const antes = await uma(
      `select position($y$ENCERRADO_SEM_EFEITO_FINANCEIRO$y$ in p.prosrc) p
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(antes.p)).toBeGreaterThan(0);

    await db.exec(semTransacao(MIG_RESERVA));

    const depois = await uma(
      `select position($y$ENCERRADO_SEM_EFEITO_FINANCEIRO$y$ in p.prosrc) p
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(depois.p)).toBe(0);
  });

  it("e reaplicar esta migration depois dela recoloca o predicado", async () => {
    await db.exec(semTransacao(MIGRATION));
    const r = await uma(
      `select (length(p.prosrc) - length(replace(p.prosrc, $x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$, '')))
              / length($x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$) n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'`
    );
    expect(Number(r.n)).toBe(1);
  });
});
