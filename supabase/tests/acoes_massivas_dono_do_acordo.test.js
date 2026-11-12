// ACOES MASSIVAS: o universo respeita o RESPONSAVEL PELO ACORDO.
//
// Parte da definicao PUBLICADA em producao apos a combinada 20261112120000
// (fixture prod_20261112_universo_pos_combinada.sql: helper de fidelizacao +
// universo, MD5 cefd206824186d4da8e6f1e35c14beb8), reproduz o defeito, aplica a
// migration pendente 20261112210000 e comprova as regras. Nenhum dado real.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, comoGestao, alunos, universo, acordoVencido,
  OP_A, OP_B, OP_INATIVA,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_dono_do_acordo/prod_20261112_universo_pos_combinada.sql");
const MIG = ler("../aguardando_aprovacao/20261112210000_acoes_massivas_dono_do_acordo.sql.pendente");
const ROLLBACK = ler("../aguardando_aprovacao/20261112210000_acoes_massivas_dono_do_acordo.rollback.sql");
const MD5_PUBLICADO = "cefd206824186d4da8e6f1e35c14beb8";
const MD5_FINAL = "8f94a1687f0f3d13765ecf86db1d1e19";
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";

let db;
beforeEach(async () => {
  db = await novoBanco();
  await db.exec(PUBLICADO);            // o que esta em producao hoje
  await comoGestao(db);
});

const md5 = async () => (await db.query(
  "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'")).rows[0].m;
const disp = (rows) => rows.filter((r) => r.disponivel).map((r) => r.aluno_id).sort();
const motivo = (rows, id) => rows.find((r) => r.aluno_id === id)?.motivo;
const semDuplicidade = (rows) => new Set(rows.map((r) => r.aluno_id)).size === rows.length;
// a selecao como a tela/previa montam: caso + acordo
const sel = (tipo, caso, acordo) => ({
  operador: `caso:${caso.join("|")}` + (acordo ? `;acordo:${acordo.join("|")}` : ""),
  responsaveis_caso: caso, ...(acordo ? { responsaveis_acordo: acordo } : {}), tipo_cobranca: tipo,
});

// Cenario base: todos da carteira de OP_A, acionados ha 30 dias (fora da fidelizacao).
//   proprio : acordo vencido de OP_A        terceiro: acordo vencido de OP_B
//   semDono : acordo vencido sem responsavel   soMens: so mensalidade
async function cenario() {
  const [proprio] = await alunos(db, 1, { dono: OP_A, ini: 1, acionadoDias: 30 });
  const [terceiro] = await alunos(db, 1, { dono: OP_A, ini: 2, acionadoDias: 30 });
  const [semDono] = await alunos(db, 1, { dono: OP_A, ini: 3, acionadoDias: 30 });
  const [soMens] = await alunos(db, 1, { dono: OP_A, ini: 4, acionadoDias: 30 });
  await acordoVencido(db, proprio, OP_A);
  await acordoVencido(db, terceiro, OP_B);
  await acordoVencido(db, semDono, null);
  return { proprio, terceiro, semDono, soMens };
}

describe("publicado hoje (antes da migration)", () => {
  it("o fixture tem o MD5 publicado", async () => { expect(await md5()).toBe(MD5_PUBLICADO); });

  it("DEFEITO: ACORDOS_VENCIDOS ignora o responsavel pelo acordo", async () => {
    const c = await cenario();
    const r = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], [OP_A]));
    expect(disp(r)).toContain(c.terceiro);   // acordo de OP_B entra mesmo pedindo so OP_A
  });
});

describe("depois da migration 20261112210000", () => {
  beforeEach(async () => { await db.exec(emTransacao(MIG)); });

  it("MD5 final e o validado", async () => { expect(await md5()).toBe(MD5_FINAL); });

  it("ACORDOS_VENCIDOS: so o acordo de quem foi escolhido", async () => {
    const c = await cenario();
    const r = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], [OP_A]));
    expect(disp(r)).toEqual([c.proprio]);
    expect(motivo(r, c.terceiro)).toBe("fora_tipo_cobranca");
    expect(motivo(r, c.semDono)).toBe("fora_tipo_cobranca");
    expect(motivo(r, c.soMens)).toBe("fora_tipo_cobranca");
  });

  it("varios responsaveis pelo acordo e 'sem_responsavel' entram por selecao explicita", async () => {
    const c = await cenario();
    const r1 = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], [OP_A, OP_B]));
    expect(disp(r1)).toEqual([c.proprio, c.terceiro].sort());
    const r2 = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], ["sem_responsavel"]));
    expect(disp(r2)).toEqual([c.semDono]);
    expect(semDuplicidade(r1) && semDuplicidade(r2)).toBe(true);
  });

  it("MENSALIDADES_E_ACORDOS: mensalidade + acordo do escolhido, sem duplicar aluno", async () => {
    const c = await cenario();
    const r = await universo(db, sel("MENSALIDADES_E_ACORDOS", [OP_A], [OP_A]));
    // todos tem mensalidade em aberto na carteira de OP_A: entram uma vez cada
    expect(disp(r)).toEqual([c.proprio, c.terceiro, c.semDono, c.soMens].sort());
    expect(semDuplicidade(r)).toBe(true);
    // o flag de acordo vencido so vale para o acordo do escolhido
    const tav = Object.fromEntries(r.map((x) => [x.aluno_id, x.tem_acordo_vencido]));
    expect(tav[c.proprio]).toBe(true);
    expect(tav[c.terceiro]).toBe(false);
    expect(tav[c.semDono]).toBe(false);
  });

  it("responsavel pelo CASO continua valendo junto com o do acordo", async () => {
    const c = await cenario();
    const [deOutro] = await alunos(db, 1, { dono: OP_B, ini: 11, acionadoDias: 30 });
    await acordoVencido(db, deOutro, OP_A);       // acordo de OP_A em caso de OP_B
    const r = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], [OP_A]));
    expect(disp(r)).toEqual([c.proprio]);
    expect(motivo(r, deOutro)).toBe("outro_responsavel");
  });

  it("acordo em dia continua fora, com ou sem o filtro de dono", async () => {
    const emDia = await alunos(db, 2, { dono: OP_A, ini: 21, acionadoDias: 30, acordoEmDia: true });
    for (const tipo of ["ACORDOS_VENCIDOS", "MENSALIDADES_E_ACORDOS"]) {
      const r = await universo(db, sel(tipo, [OP_A], [OP_A, "sem_responsavel"]));
      for (const id of emDia) expect(disp(r)).not.toContain(id);
    }
    const m = await universo(db, sel("MENSALIDADES", [OP_A]));
    for (const id of emDia) expect(disp(m)).not.toContain(id);
  });

  it("fidelizacao: 10o dia protegido, 11o dia liberado, tambem com acordo", async () => {
    const [d10] = await alunos(db, 1, { dono: OP_A, ini: 31, acionadoDias: 10 });
    const [d11] = await alunos(db, 1, { dono: OP_A, ini: 32, acionadoDias: 11 });
    await acordoVencido(db, d10, OP_A);
    await acordoVencido(db, d11, OP_A);
    for (const tipo of ["ACORDOS_VENCIDOS", "MENSALIDADES_E_ACORDOS"]) {
      const r = await universo(db, sel(tipo, [OP_A], [OP_A]));
      expect(motivo(r, d10)).toBe("fidelizacao_ativa");
      expect(disp(r)).toEqual([d11]);
    }
  });

  it("demais protecoes preservadas: retorno futuro, liquidado no Prime, confirmacao pendente", async () => {
    const [ret] = await alunos(db, 1, { dono: OP_A, ini: 41, acionadoDias: 30, retornoEmDias: 3 });
    const [liq] = await alunos(db, 1, { dono: OP_A, ini: 42, acionadoDias: 30, liquidado: true });
    const [conf] = await alunos(db, 1, { dono: OP_A, ini: 43, acionadoDias: 30, confirmacao: true });
    for (const id of [ret, liq, conf]) await acordoVencido(db, id, OP_A);
    const r = await universo(db, sel("ACORDOS_VENCIDOS", [OP_A], [OP_A]));
    expect(disp(r)).toEqual([]);
    expect(motivo(r, ret)).toBe("retorno_futuro");
    expect(motivo(r, liq)).toBe("liquidado_prime");
    expect(motivo(r, conf)).toBe("confirmacao_pendente");
  });

  it("sem responsaveis_acordo nada muda: MENSALIDADES, todos e livres iguais ao publicado", async () => {
    const c = await cenario();
    await alunos(db, 2, { dono: OP_INATIVA, ini: 51, acionadoDias: 30 });
    await alunos(db, 2, { dono: null, ini: 61 });
    const filtros = [
      sel("MENSALIDADES", [OP_A]),
      { operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS" },
      { operador: "livres", tipo_cobranca: "MENSALIDADES_E_ACORDOS" },
      { operador: "todos", tipo_cobranca: "ACORDOS_VENCIDOS" },
    ];
    const foto = async () => {
      const out = [];
      for (const f of filtros) out.push((await universo(db, f)).map((x) => [x.aluno_id, x.disponivel, x.motivo, x.tem_acordo_vencido]).sort());
      return JSON.stringify(out);
    };
    const depois = await foto();
    await db.exec(emTransacao(ROLLBACK));          // volta ao publicado
    expect(await md5()).toBe(MD5_PUBLICADO);
    expect(await foto()).toBe(depois);
    expect(c.soMens).toBeTruthy();
  });

  it("rollback restaura o publicado e recusa se a funcao mudou", async () => {
    await db.exec(emTransacao(ROLLBACK));
    expect(await md5()).toBe(MD5_PUBLICADO);
    await expect(db.exec(emTransacao(ROLLBACK))).rejects.toThrow(/Rollback abortado/);
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
