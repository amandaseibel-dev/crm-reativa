// PREVIA DO ACORDO A VISTA: FICHA MESCLADA COMO CADASTRO_DUPLICADO NAO CONTA.
//
// Roda a migration REAL em PGlite sobre a bancada com os corpos de producao
// (previa do a vista conferida por md5, registrador, motor, recuperacao
// automatica). O estado "antes" e o proprio rollback.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, um, boletoDe } from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20260918140000_previa_ignora_cadastro_duplicado_mesclado.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918140000_previa_ignora_cadastro_duplicado_mesclado.rollback.sql");

const OPERADOR = "cobranca11@aelbra.com.br";
const A = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;
const P = (n) => `00000000-0000-4000-9000-0000000${String(n).padStart(5, "0")}`;
const CPF = "70000000080";
const NOME = "ALUNO DE TESTE DUPLICADO";
const MATRICULA = "2026003872";
const MARCA_OFICIAL = "CADASTRO DUPLICADO mesclado em 18/09/2026 no cadastro x (lote teste)";

async function banco({ nova = true, ligada = false } = {}) {
  const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: ligada });
  await db.exec(`alter table public.alunos add column if not exists observacao text`);
  if (nova) await db.exec(MIGRATION);
  await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operador', $1, 'operador', true)`, [OPERADOR]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [CPF, MATRICULA]);
  return db;
}

// a ficha "boa": mensalidade em aberto
async function fichaAtiva(db, n) {
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, saldo_total)
                  values ($1, $2, $3, '***', null, 'ULBRA POP', 'ACORDO_FECHADO', 947.34)`, [A(n), NOME, CPF]);
  await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido,
                    situacao, status, tipo_boleto)
                  values ($1, $2, 'doc1', '2026-08-05', 947.34, 947.34, 'ABERTO', 'em_aberto', 'Cursos de Graduação')`,
    [`00000000-0000-4000-a000-0000000${String(n).padStart(5, "0")}`, A(n)]);
  return A(n);
}

// a gemea vazia, mesmo CPF e nome; `marca` decide como ela esta marcada
async function fichaGemea(db, n, marca) {
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, unidade, status_atual, status_jornada, observacao)
                  values ($1, $2, $3, '***', 'ULBRA POP', 'CONTATAR', $4, $5)`,
    [A(n), NOME, CPF, marca === "nenhuma" ? null : "CADASTRO_DUPLICADO", marca === "oficial" ? MARCA_OFICIAL : null]);
  return A(n);
}

async function pagar(db, numero) {
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, 1071.49, 0, '2026-09-17', $5, 'Allan', $6, $7)`,
    [P(1), boletoDe(numero, 1), JSON.stringify({ vencimento: "2026-09-18", valor_original: 1071.49 }),
      String(numero), OPERADOR, NOME, MATRICULA]);
  return P(1);
}

const previa = (db, pid) => um(db, `select public.acordo_avista_previa($1, null)`, [pid]);

describe("identificação do aluno na prévia", () => {
  it("ficha ativa + ficha CADASTRO_DUPLICADO marcada pela mesclagem oficial = um único aluno válido", async () => {
    const db = await banco();
    const boa = await fichaAtiva(db, 72283);
    await fichaGemea(db, 72284, "oficial");
    const pid = await pagar(db, 72283);
    const r = await previa(db, pid);
    expect(r.bloqueios).not.toContain("MATRICULA_APONTA_UM_ALUNO");
    expect(r.bloqueios).not.toContain("NOME_APONTA_UM_ALUNO");
    expect(r.aluno.id).toBe(boa);
    expect(r.aprovado).toBe(true);
    await db.close();
  });

  it("duas fichas ativas com o mesmo CPF e nome continuam bloqueando", async () => {
    const db = await banco();
    await fichaAtiva(db, 72283);
    await fichaGemea(db, 72284, "nenhuma");
    const pid = await pagar(db, 72283);
    const r = await previa(db, pid);
    expect(r.aprovado).toBe(false);
    expect(r.bloqueios).toContain("MATRICULA_APONTA_UM_ALUNO");
    expect(r.bloqueios).toContain("NOME_APONTA_UM_ALUNO");
    await db.close();
  });

  it("status CADASTRO_DUPLICADO sem a observação da mesclagem oficial continua contando", async () => {
    const db = await banco();
    await fichaAtiva(db, 72283);
    await fichaGemea(db, 72284, "so_status");
    const pid = await pagar(db, 72283);
    const r = await previa(db, pid);
    expect(r.aprovado).toBe(false);
    expect(r.bloqueios).toContain("MATRICULA_APONTA_UM_ALUNO");
    await db.close();
  });

  it("mutação: a prévia de produção de hoje recusa o mesmo cenário da mesclagem oficial", async () => {
    const db = await banco({ nova: false });
    await fichaAtiva(db, 72283);
    await fichaGemea(db, 72284, "oficial");
    const pid = await pagar(db, 72283);
    const r = await previa(db, pid);
    expect(r.aprovado).toBe(false);
    expect(r.bloqueios).toContain("MATRICULA_APONTA_UM_ALUNO");
    await db.close();
  });
});

describe("recuperação automática com a ficha mesclada", () => {
  it("sem JWT, pela importação: BAIXADO, acordo QUITADO no aluno certo, mensalidade PAGO e vinculada", async () => {
    const db = await banco({ ligada: true });
    const boa = await fichaAtiva(db, 72283);
    const gemea = await fichaGemea(db, 72284, "oficial");
    const pid = await pagar(db, 72283);
    const r = await um(db, `select jsonb_build_object(
        'pag', (select status_conciliacao from public.pagamentos where id = $1),
        'acordo_aluno', (select a.aluno_id from public.acordos a join public.parcelas q on q.acordo_id = a.id where q.origem_baixa_ref = $1::text),
        'acordo_status', (select a.status from public.acordos a join public.parcelas q on q.acordo_id = a.id where q.origem_baixa_ref = $1::text),
        'mens', (select situacao from public.acordos_titulos where aluno_id = $2),
        'vinc', (select count(*)::int from public.acordo_titulo_vinculo v join public.acordos_titulos t on t.id = v.titulo_id where t.aluno_id = $2 and v.ativo),
        'gemea_intocada', (select count(*)::int from public.acordos where aluno_id = $3) = 0)`, [pid, boa, gemea]);
    expect(r).toEqual({ pag: "BAIXADO", acordo_aluno: boa, acordo_status: "QUITADO", mens: "PAGO", vinc: 1, gemea_intocada: true });
    await db.close();
  });
});

describe("rollback", () => {
  it("devolve o corpo de produção (md5 9e062e76)", async () => {
    const db = await banco();
    await db.exec(ROLLBACK);
    expect(await um(db, `select md5(prosrc) from pg_proc where proname = 'acordo_avista_previa'`)).toBe("9e062e7600cd7b04a17fb9db65469bfe");
    await db.close();
  });
});
