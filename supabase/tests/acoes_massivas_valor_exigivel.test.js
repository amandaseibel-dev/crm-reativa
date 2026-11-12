// ACOES MASSIVAS: `valor` e o filtro de faixa passam a usar o VALOR EXIGIVEL do
// recorte, e nao casos.total_em_aberto.
//
// Parte da definicao PUBLICADA em producao em 12/11/2026, depois de
// 20261112210000 (fixture prod_20261112_universo_pos_dono_do_acordo.sql, MD5
// 8f94a1687f0f3d13765ecf86db1d1e19, com o helper de fidelizacao), reproduz o
// defeito, aplica a migration pendente 20261112235500 e comprova o valor, o
// filtro e que ninguem com divida vencida deixa de entrar. Nenhum dado real.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, comoGestao, alunos, universo, acordoVencido, OP_A, OP_B,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const MIG = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const ROLLBACK = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.rollback.sql");
const MD5_PUBLICADO = "8f94a1687f0f3d13765ecf86db1d1e19";
const MD5_FINAL = "a44af07e4e52dd68f5632977d99352dc";
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";

let db;
beforeEach(async () => {
  db = await novoBanco();
  await db.exec(PUBLICADO);
  await comoGestao(db);
});

const md5 = async () => (await db.query(
  `select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acoes_massivas_universo'`)).rows[0].m;
const linha = (rows, id) => rows.find((r) => r.aluno_id === id);
const valor = (rows, id) => Number(linha(rows, id)?.valor);
const disp = (rows) => rows.filter((r) => r.disponivel).map((r) => r.aluno_id).sort();
const MENS = (extra = {}) => ({ operador: "todos", tipo_cobranca: "MENSALIDADES", ...extra });
const ACORDOS = (extra = {}) => ({ operador: "todos", tipo_cobranca: "ACORDOS_VENCIDOS", ...extra });
const JUNTOS = (extra = {}) => ({ operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS", ...extra });

// alunos() cria 1 titulo ABERTO de R$ 100, vencido em marco, e um caso com `valor`.
const tituloExtra = (alunoId, { valor: v = 250, dias = -60, situacao = "ABERTO", status = "em_aberto", tipo = null } = {}) =>
  db.query(
    `insert into public.acordos_titulos (aluno_id, situacao, vencimento, status, tipo_boleto, valor_original)
     values ($1, $2, current_date + $3::int, $4, $5, $6) returning id`,
    [alunoId, situacao, dias, status, tipo, v]).then((r) => r.rows[0].id);
const zerarCaso = (alunoId) => db.query(`update public.casos set total_em_aberto = 0 where aluno_id = $1`, [alunoId]);

describe("publicado hoje (antes da migration)", () => {
  it("o fixture tem o MD5 publicado", async () => { expect(await md5()).toBe(MD5_PUBLICADO); });

  it("DEFEITO: o valor e o saldo do caso -- caso zerado com titulo vencido aparece com zero", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await zerarCaso(id);
    const r = await universo(db, MENS());
    expect(valor(r, id)).toBe(0);
    // e o filtro "de 0 a 300" o seleciona como se devesse pouco, mesmo devendo mais
    await tituloExtra(id, { valor: 5000 });
    expect(disp(await universo(db, MENS({ valor_min: 0, valor_max: 300 })))).toContain(id);
  });
});

describe("depois da migration 20261112235500", () => {
  beforeEach(async () => { await db.exec(emTransacao(MIG)); });

  it("MD5 final e o validado", async () => { expect(await md5()).toBe(MD5_FINAL); });

  it("valor = mensalidades vencidas, qualquer que seja o saldo do caso", async () => {
    const [zerado] = await alunos(db, 1, { ini: 1 });
    const [inflado] = await alunos(db, 1, { ini: 2, valor: 99999 });
    await zerarCaso(zerado);
    await tituloExtra(zerado, { valor: 250 });
    const r = await universo(db, MENS());
    expect(valor(r, zerado)).toBe(350);        // 100 + 250
    expect(valor(r, inflado)).toBe(100);
    expect(disp(r)).toEqual([zerado, inflado].sort());
  });

  it("titulo a vencer nao e exigivel: nao entra no valor", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await tituloExtra(id, { valor: 700, dias: 20 });
    expect(valor(await universo(db, MENS()), id)).toBe(100);
  });

  it("quem so tem titulo a vencer fica indisponivel, mesmo com valor minimo zero", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await db.query(`update public.acordos_titulos set vencimento = current_date + 15 where aluno_id = $1`, [id]);
    const r = await universo(db, MENS({ valor_min: 0 }));
    expect(valor(r, id)).toBe(0);
    expect(linha(r, id).disponivel).toBe(false);
    expect(linha(r, id).motivo).toBe("valor_fora_da_faixa");
  });

  it("titulo quitado, pago ou boleto de acordo nao entra no valor", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    await tituloExtra(id, { valor: 400, status: "quitada" });
    await tituloExtra(id, { valor: 500, situacao: "PAGO" });
    await tituloExtra(id, { valor: 600, tipo: "Acordo" });
    expect(valor(await universo(db, MENS()), id)).toBe(100);
  });

  it("titulo incorporado em acordo nao cancelado nao e somado; em acordo cancelado, volta a ser", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    const t = await tituloExtra(id, { valor: 900, situacao: "NEGOCIADO" });
    const ac = (await db.query(`insert into public.acordos (aluno_id, status) values ($1, 'CANCELADO') returning id`, [id])).rows[0].id;
    await db.query(`insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo) values ($1, $2, true)`, [t, ac]);
    expect(valor(await universo(db, MENS()), id)).toBe(1000);           // vinculo so com acordo cancelado: conta
    await db.query(`update public.acordos set status = 'QUITADO' where id = $1`, [ac]);
    expect(valor(await universo(db, MENS()), id)).toBe(100);            // incorporado: nao conta
  });

  it("o filtro de faixa usa o valor exigivel", async () => {
    const [pouco] = await alunos(db, 1, { ini: 1, valor: 99999 });      // deve 100
    const [muito] = await alunos(db, 1, { ini: 2, valor: 0 });          // deve 100 + 5000
    await tituloExtra(muito, { valor: 5000 });
    const ate300 = await universo(db, MENS({ valor_min: 0, valor_max: 300 }));
    expect(disp(ate300)).toEqual([pouco]);
    expect(linha(ate300, muito).motivo).toBe("valor_fora_da_faixa");
    const acima1000 = await universo(db, MENS({ valor_min: 1000 }));
    expect(disp(acima1000)).toEqual([muito]);
  });

  it("acordo vencido: valor = parcelas VENCIDAS do acordo, sem somar a mensalidade (sem dupla contagem)", async () => {
    const [id] = await alunos(db, 1, { ini: 1, valor: 0 });             // mensalidade de 100
    const ac = await acordoVencido(db, id, OP_A);                       // parcela vencida de 100
    await db.query(`insert into public.parcelas (acordo_id, status, vencimento, valor) values ($1, 'VENCIDA', current_date - 5, 320)`, [ac]);
    await db.query(`insert into public.parcelas (acordo_id, status, vencimento, valor) values ($1, 'A_VENCER', current_date + 25, 320)`, [ac]);
    await db.query(`insert into public.parcelas (acordo_id, status, vencimento, valor) values ($1, 'PAGO', current_date - 60, 320)`, [ac]);
    for (const f of [ACORDOS(), JUNTOS()]) {
      const r = await universo(db, f);
      expect(valor(r, id)).toBe(420);                                   // 100 + 320, so as vencidas
      expect(linha(r, id).disponivel).toBe(true);
    }
  });

  it("acordo de outro responsavel fora da selecao: vale a mensalidade", async () => {
    const [id] = await alunos(db, 1, { ini: 1, dono: OP_A, acionadoDias: 30 });
    await acordoVencido(db, id, OP_B);
    const f = { operador: `caso:${OP_A};acordo:${OP_A}`, responsaveis_caso: [OP_A], responsaveis_acordo: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" };
    const r = await universo(db, f);
    expect(linha(r, id).tem_acordo_vencido).toBe(false);
    expect(valor(r, id)).toBe(100);
  });

  it("quem tem divida vencida continua entrando: disponiveis iguais aos de antes", async () => {
    await alunos(db, 3, { ini: 1 });
    await alunos(db, 2, { ini: 11, dono: OP_A, acionadoDias: 30 });
    const [comAcordo] = await alunos(db, 1, { ini: 21 });
    await acordoVencido(db, comAcordo, OP_A);
    const foto = async () => {
      const out = [];
      for (const f of [MENS(), ACORDOS(), JUNTOS(), { operador: "livres", tipo_cobranca: "MENSALIDADES" }]) {
        out.push((await universo(db, f)).map((x) => [x.aluno_id, x.disponivel, x.motivo, x.tem_mensalidade, x.tem_acordo_vencido]).sort());
      }
      return JSON.stringify(out);
    };
    const depois = await foto();
    await db.exec(emTransacao(ROLLBACK));
    expect(await foto()).toBe(depois);
  });

  it("protecoes preservadas: fidelizacao, retorno futuro, liquidado no Prime, confirmacao pendente", async () => {
    const [fid] = await alunos(db, 1, { ini: 1, dono: OP_A, acionadoDias: 10 });
    const [ret] = await alunos(db, 1, { ini: 2, retornoEmDias: 3 });
    const [liq] = await alunos(db, 1, { ini: 3, liquidado: true });
    const [conf] = await alunos(db, 1, { ini: 4, confirmacao: true });
    const r = await universo(db, MENS());
    expect(linha(r, fid).motivo).toBe("fidelizacao_ativa");
    expect(linha(r, ret).motivo).toBe("retorno_futuro");
    expect(linha(r, liq).motivo).toBe("liquidado_prime");
    expect(linha(r, conf).motivo).toBe("confirmacao_pendente");
  });

  it("sem duplicidade: um aluno com varios titulos aparece uma vez", async () => {
    const [id] = await alunos(db, 1, { ini: 1 });
    for (let i = 0; i < 4; i++) await tituloExtra(id, { valor: 50 });
    const r = await universo(db, MENS());
    expect(r.filter((x) => x.aluno_id === id)).toHaveLength(1);
    expect(valor(r, id)).toBe(300);
  });

  it("seguranca: dono, security definer, search_path, timeout e grants identicos", async () => {
    const meta = async () => (await db.query(
      `select pg_get_userbyid(p.proowner) dono, p.prosecdef, p.provolatile, p.proconfig::text config, coalesce(p.proacl::text, '') acl,
              pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) retorno
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'acoes_massivas_universo'`)).rows;
    await db.exec(emTransacao(ROLLBACK));
    await db.exec(`revoke all on function public.acoes_massivas_universo(jsonb) from public;
                   grant execute on function public.acoes_massivas_universo(jsonb) to authenticated;`);
    const antes = await meta();
    expect(antes[0].prosecdef).toBe(true);
    expect(antes[0].config).toContain("search_path=public");
    await db.exec(emTransacao(MIG));
    expect(await meta()).toEqual(antes);
    await db.exec(emTransacao(ROLLBACK));
    expect(await meta()).toEqual(antes);
  });

  it("rollback restaura o publicado e recusa rodar duas vezes", async () => {
    await db.exec(emTransacao(ROLLBACK));
    expect(await md5()).toBe(MD5_PUBLICADO);
    await expect(db.exec(emTransacao(ROLLBACK))).rejects.toThrow(/Rollback abortado/);
    await db.exec("ROLLBACK;").catch(() => {});
  });
});

describe("guardas da migration", () => {
  it("aborta sem alterar nada se a definicao publicada for outra", async () => {
    const adulterada = PUBLICADO.replace("  f jsonb := coalesce(p_filtros, '{}'::jsonb);", "  f jsonb := coalesce(p_filtros, '{}'::jsonb); -- alterado");
    expect(adulterada).not.toBe(PUBLICADO);
    await db.exec(adulterada);
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
