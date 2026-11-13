// ACOES MASSIVAS: valor exigivel do recorte (regra reformulada).
//
// Parte da definicao PUBLICADA em producao (8f94a168..., com #935), aplica a migration
// pendente 20261112235500 e comprova: mensalidade independente entra; acordo entra pela
// campanha; a dupla contagem e evitada nos casos verificados (vinculo a acordo e boleto
// igual a parcela ATIVO; outras sobreposicoes nao foram comprovadas, ver R1); titulos pagos, a vencer, devolvidos, em confirmacao
// e duplicados ficam fora; o dono do acordo e respeitado; protecoes preservadas.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, comoGestao, alunos, universo, OP_A, OP_B } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const MIG = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const ROLLBACK = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.rollback.sql");
const MD5_PUBLICADO = "8f94a1687f0f3d13765ecf86db1d1e19";
const MD5_FINAL = "43fea46519b30f24353d722ec0d2db3b";
const TIPO_PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql");
const MD5_TIPO_PUBLICADO = "323628b786a44f2a108210f8beafea8b";
const MD5_TIPO_FINAL = "d3e5dc840b72a6fc2d7d68b4dd3070c6";
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";

let db;
beforeEach(async () => {
  db = await novoBanco();
  await db.exec(`alter table public.acordos_titulos add column if not exists documento text;
                 alter table public.parcelas add column if not exists boleto text;
                 alter table public.acordos add column if not exists saldo numeric default 0;`);
  await db.exec(PUBLICADO);
  // a bancada traz um stub simplificado; a funcao real e a publicada, com hash conferido
  await db.exec(TIPO_PUBLICADO);
  await comoGestao(db);
});

const md5 = async () => (await db.query(
  "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].m;
const linha = (rows, id) => rows.find((r) => r.aluno_id === id);
const valor = (rows, id) => Number(linha(rows, id)?.valor);
// a universe devolve TODOS os candidatos com disponivel/motivo; "fora" = nao disponivel
const disponivelEm = (rows, id) => linha(rows, id)?.disponivel === true;
const MENS = (x = {}) => ({ operador: "todos", tipo_cobranca: "MENSALIDADES", ...x });
const ACORD = (x = {}) => ({ operador: "todos", tipo_cobranca: "ACORDOS_VENCIDOS", ...x });
const JUNT = (x = {}) => ({ operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS", ...x });
const titulo = (id, o = {}) => db.query(
  `insert into public.acordos_titulos (aluno_id, situacao, vencimento, status, tipo_boleto, valor_original, documento)
   values ($1, $2, current_date + $3::int, $4, $5, $6, $7) returning id`,
  [id, o.situacao ?? "ABERTO", o.dias ?? -60, o.status ?? "em_aberto", o.tipo ?? null, o.v ?? 250, o.doc ?? null]).then((r) => r.rows[0].id);
const acordo = (id, o = {}) => db.query(
  `insert into public.acordos (aluno_id, status, operador_responsavel_email, saldo) values ($1, $2, $3, 100) returning id`,
  [id, o.status ?? "ATIVO", o.dono ?? null]).then((r) => r.rows[0].id);
const parcela = (ac, o = {}) => db.query(
  `insert into public.parcelas (acordo_id, status, vencimento, valor, boleto) values ($1, $2, current_date + $3::int, $4, $5)`,
  [ac, o.status ?? "VENCIDA", o.dias ?? -20, o.v ?? 320, o.boleto ?? null]);
const zerarCaso = (id) => db.query("update public.casos set total_em_aberto = 0 where aluno_id = $1", [id]);

describe("publicado hoje (antes da migration)", () => {
  it("MD5 de origem confere", async () => { expect(await md5()).toBe(MD5_PUBLICADO); });
  it("DEFEITO: o valor e o saldo do caso (caso zerado mostra zero com titulo vencido)", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await zerarCaso(id);
    expect(valor(await universo(db, MENS()), id)).toBe(0);
  });
});

describe("depois da migration", () => {
  beforeEach(async () => { await db.exec(emTransacao(MIG)); });

  it("MD5 final confere", async () => { expect(await md5()).toBe(MD5_FINAL); });

  it("mensalidade vencida independente entra, mesmo com o caso zerado", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 0 });
    expect(valor(await universo(db, MENS()), id)).toBe(100);
  });

  it("titulo a vencer nao e exigivel", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set vencimento = current_date + 15 where aluno_id = $1", [id]);
    expect(valor(await universo(db, MENS()), id)).toBe(0);
  });

  it("titulo incorporado a acordo nao cancelado nao soma; de acordo cancelado, conta", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const t = (await db.query("select id from public.acordos_titulos where aluno_id = $1", [id])).rows[0].id;
    const ac = await acordo(id, { status: "CANCELADO" });
    await db.query("insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo) values ($1, $2, true)", [t, ac]);
    expect(valor(await universo(db, MENS()), id)).toBe(100);
    // Acordo QUITADO nao e cancelado: o titulo ja foi liquidado pelo acordo, nao e cobrado de novo.
    await db.query("update public.acordos set status = 'QUITADO' where id = $1", [ac]);
    expect(valor(await universo(db, MENS()), id)).toBe(0);
  });

  it("boleto do titulo igual ao de parcela de acordo ATIVO: nao soma (mesma divida)", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set documento = '5550001' where aluno_id = $1", [id]);
    const ac = await acordo(id);
    await parcela(ac, { status: "A_VENCER", dias: 10, boleto: "5550001", v: 999 });
    const r = await universo(db, MENS());
    expect(valor(r, id)).toBe(0);
  });

  it("MENSALIDADES_E_ACORDOS com boleto igual e parcela VENCIDA: conta so a parcela (caso verificado de dupla contagem)", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set documento = '0005550002' where aluno_id = $1", [id]);
    const ac = await acordo(id);
    await parcela(ac, { v: 320, boleto: "5550002" });
    expect(valor(await universo(db, JUNT()), id)).toBe(320);
    expect(valor(await universo(db, MENS()), id)).toBe(0);
    expect(valor(await universo(db, ACORD()), id)).toBe(320);
  });

  it("LIMITE CONHECIDO: titulo sem documento e sem vinculo e tratado como independente e soma com o acordo", async () => {
    // Sem vinculo e sem boleto em comum nao ha como provar que e a mesma divida. Soma as duas.
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { v: 320 });
    expect(valor(await universo(db, JUNT()), id)).toBe(420);
  });

  it("CORRIGIDO: so titulo a vencer nao e disponivel em mensalidades (fora do tipo de cobranca)", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set vencimento = current_date + 15 where aluno_id = $1", [id]);
    expect(disponivelEm(await universo(db, MENS()), id)).toBe(false);
  });

  it("CORRIGIDO: titulo NEGOCIADO sem vinculo nao qualifica mensalidades", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set situacao = 'NEGOCIADO' where aluno_id = $1", [id]);
    expect(disponivelEm(await universo(db, MENS()), id)).toBe(false);
  });

  it("REGRESSAO (achado A do Guardiao): dono do acordo excluido + boleto igual a parcela VENCIDA nao fica disponivel com valor zero", async () => {
    const [id] = await alunos(db, 1, { ini: 1, dono: OP_A, acionadoDias: 30 });
    await db.query("update public.acordos_titulos set documento = '0007000001' where aluno_id = $1", [id]);
    const ac = (await db.query("insert into public.acordos (aluno_id, status, operador_responsavel_email, saldo) values ($1,'ATIVO',$2,100) returning id", [id, OP_B])).rows[0].id;
    await db.query("insert into public.parcelas (acordo_id, status, vencimento, valor, boleto) values ($1,'VENCIDA', current_date - 20, 320, '7000001')", [ac]);
    const r = await universo(db, { operador: "caso:" + OP_A + ";acordo:" + OP_A, responsaveis_caso: [OP_A], responsaveis_acordo: [OP_A], tipo_cobranca: "MENSALIDADES" });
    expect(disponivelEm(r, id)).toBe(false);
  });

  it("F1: parcela VENCIDA com vencimento futuro nao torna o aluno elegivel a ACORDOS_VENCIDOS nem a MENSALIDADES_E_ACORDOS", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { status: "VENCIDA", dias: 20, v: 320 });
    expect(disponivelEm(await universo(db, ACORD()), id)).toBe(false);
    expect(disponivelEm(await universo(db, JUNT()), id)).toBe(false);
  });

  it("mensalidade vencida independente com acordo ATIVO em dia (sem vencida): segue fora, como antes", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { status: "A_VENCER", dias: 20, v: 320 });
    expect(disponivelEm(await universo(db, MENS()), id)).toBe(false);
  });

  it("combinada: aluno com mensalidade vencida E acordo vencido aparece so em MENSALIDADES_E_ACORDOS", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { v: 320 });
    expect(disponivelEm(await universo(db, MENS()), id)).toBe(false);   // tem acordo vencido: fica nos acordos
    expect(valor(await universo(db, ACORD()), id)).toBe(320);
    expect(valor(await universo(db, JUNT()), id)).toBe(420);
  });

  it("tipo de cobranca: MENSALIDADES nao recebe aluno so com acordo vencido", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query("update public.acordos_titulos set situacao = 'PAGO' where aluno_id = $1", [id]);
    const ac = await acordo(id);
    await parcela(ac, { v: 320 });
    expect(disponivelEm(await universo(db, MENS()), id)).toBe(false);
    expect(valor(await universo(db, ACORD()), id)).toBe(320);
  });

  it("ACORDOS_VENCIDOS: valor = so as parcelas vencidas do acordo", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { v: 320 });
    await parcela(ac, { status: "A_VENCER", dias: 20, v: 320 });
    await parcela(ac, { status: "PAGO", dias: -60, v: 320 });
    expect(valor(await universo(db, ACORD()), id)).toBe(320);
  });

  it("MENSALIDADES_E_ACORDOS: mensalidade independente (boleto distinto) + acordo vencido soma as duas", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const ac = await acordo(id);
    await parcela(ac, { v: 320 });
    expect(valor(await universo(db, JUNT()), id)).toBe(420);
  });

  it("parcela de acordo CANCELADO nao conta", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 0 });
    const ac = await acordo(id, { status: "CANCELADO" });
    await parcela(ac, { v: 320 });
    expect(valor(await universo(db, ACORD()), id)).toBe(0);
  });

  it("NEGOCIADO, DEVOLVIDO, EM_CONFIRMACAO e DUPLICADA nao entram no valor de mensalidade", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 0 });
    await titulo(id, { situacao: "NEGOCIADO", v: 400 });
    await titulo(id, { status: "devolvido", v: 500 });
    await titulo(id, { status: "em_confirmacao", v: 600 });
    await titulo(id, { situacao: "DUPLICADA", v: 700 });
    expect(valor(await universo(db, MENS()), id)).toBe(100);
  });

  it("acordo de outro responsavel nao entra quando a selecao traz outro", async () => {
    const [id] = await alunos(db, 1, { ini: 1, dono: OP_A, acionadoDias: 30 });
    const ac = await acordo(id, { dono: OP_B });
    await parcela(ac, { v: 320 });
    const r = await universo(db, { operador: "caso:" + OP_A + ";acordo:" + OP_A, responsaveis_caso: [OP_A], responsaveis_acordo: [OP_A], tipo_cobranca: "ACORDOS_VENCIDOS" });
    expect(valor(r, id)).toBe(0);
  });

  it("sem_responsavel no acordo entra quando escolhido", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 0 });
    const ac = await acordo(id, { dono: null });
    await parcela(ac, { v: 320 });
    const r = await universo(db, { operador: "todos", responsaveis_acordo: ["sem_responsavel"], tipo_cobranca: "ACORDOS_VENCIDOS" });
    expect(valor(r, id)).toBe(320);
  });

  it("valor nao depende do saldo do caso", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 99999 });
    expect(valor(await universo(db, MENS()), id)).toBe(100);
  });

  it("protecoes preservadas: fidelizacao 10 dias, 11 dias elegivel, retorno futuro, liquidado, confirmacao", async () => {
    const [fid] = await alunos(db, 1, { ini: 1, dono: OP_A, acionadoDias: 10 });
    const [eleg] = await alunos(db, 1, { ini: 2, dono: OP_A, acionadoDias: 11 });
    const [ret] = await alunos(db, 1, { ini: 3, retornoEmDias: 3 });
    const [liq] = await alunos(db, 1, { ini: 4, liquidado: true });
    const [conf] = await alunos(db, 1, { ini: 5, confirmacao: true });
    const r = await universo(db, MENS());
    expect(linha(r, fid).motivo).toBe("fidelizacao_ativa");
    expect(linha(r, eleg).disponivel).toBe(true);
    expect(linha(r, ret).motivo).toBe("retorno_futuro");
    expect(linha(r, liq).motivo).toBe("liquidado_prime");
    expect(linha(r, conf).motivo).toBe("confirmacao_pendente");
  });

  it("sem duplicidade", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    for (let i = 0; i < 4; i++) await titulo(id, { v: 50 });
    const r = await universo(db, MENS());
    expect(r.filter((x) => x.aluno_id === id)).toHaveLength(1);
    expect(valor(r, id)).toBe(300);
  });

  it("seguranca: dono, security definer, search_path e grants identicos", async () => {
    const meta = async () => (await db.query(
      `select pg_get_userbyid(p.proowner) dono, p.prosecdef, p.proconfig::text config, coalesce(p.proacl::text,'') acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'`)).rows;
    await db.exec(emTransacao(ROLLBACK));
    await db.exec("revoke all on function public.acoes_massivas_universo(jsonb) from public; grant execute on function public.acoes_massivas_universo(jsonb) to authenticated;");
    const antes = await meta();
    expect(antes[0].prosecdef).toBe(true);
    await db.exec(emTransacao(MIG));
    expect(await meta()).toEqual(antes);
    await db.exec(emTransacao(ROLLBACK));
    expect(await meta()).toEqual(antes);
  });

  it("funcao de tipo: hash final, e o rollback restaura o publicado", async () => {
    const md5Tipo = async () => (await db.query(
      "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'acoes_massivas_tipo_cobranca_alunos'")).rows[0].m;
    expect(await md5Tipo()).toBe(MD5_TIPO_FINAL);
    await db.exec(emTransacao(ROLLBACK));
    expect(await md5Tipo()).toBe(MD5_TIPO_PUBLICADO);
    expect(await md5()).toBe(MD5_PUBLICADO);
    await db.exec(emTransacao(MIG));
    expect(await md5Tipo()).toBe(MD5_TIPO_FINAL);
  });

  it("rollback volta ao publicado e recusa rodar duas vezes", async () => {
    await db.exec(emTransacao(ROLLBACK));
    expect(await md5()).toBe(MD5_PUBLICADO);
    await expect(db.exec(emTransacao(ROLLBACK))).rejects.toThrow(/Rollback abortado/);
    await db.exec("ROLLBACK;").catch(() => {});
  });
});

describe("guardas", () => {
  it("aborta sem alterar nada se a definicao publicada for outra", async () => {
    await db.exec(PUBLICADO.replace("  f jsonb := coalesce(p_filtros, '{}'::jsonb);", "  f jsonb := coalesce(p_filtros, '{}'::jsonb); -- alterado"));
    const antes = await md5();
    await expect(db.exec(emTransacao(MIG))).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5()).toBe(antes);
  });
  it("nao aplica duas vezes", async () => {
    await db.exec(emTransacao(MIG));
    await expect(db.exec(emTransacao(MIG))).rejects.toThrow(/Nada aplicado/);
    await db.exec("ROLLBACK;").catch(() => {});
    expect(await md5()).toBe(MD5_FINAL);
  });
});
