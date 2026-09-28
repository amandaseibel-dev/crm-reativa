// PREVENTIVO — COMPORTAMENTO, não estrutura.
//
// Roda as três migrations REAIS do Preventivo num PostgreSQL de verdade
// (PGlite) e exercita o que a gestão pediu que fosse garantido:
//
//   1. outro usuário não entra — nem pela RPC, nem lendo a tabela direto;
//   2. importar e reimportar o mesmo arquivo não duplica título nem valor,
//      e não reescreve o valor de entrada da carteira;
//   3. a prévia não grava nada;
//   4. redução de saldo NÃO vira pagamento, e reconsultar o Prime não
//      duplica movimento;
//   5. sumir do extrato não vira recebimento e não apaga o saldo anterior;
//   6. falha de consulta preserva o dado anterior;
//   7. a exportação respeita janela, saldo, situação e contato válido, e
//      "exportada" nunca vira "enviada" sozinha;
//   8. a conta do painel fecha.
//
// `auth.jwt()` e `public.usuarios` são DUBLÊS. NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATIONS = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
].map(ler);

const GESTAO = "amanda.seibel@aelbra.com.br";
const OUTRA = "cobranca07@aelbra.com.br"; // Amanda ADM — conta diferente

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', (select email from public._jwt limit 1)) $$;
    create table public.usuarios (id uuid default gen_random_uuid(), nome text, email text,
      perfil text, ativo boolean default true);
    insert into public.usuarios (nome, email, perfil) values
      ('Amanda', '${GESTAO}', 'gerencia'),
      ('Amanda Borges', '${OUTRA}', 'administrativo');
    insert into public._jwt values ('${GESTAO}');
    grant usage on schema auth to authenticated;
    grant select on public._jwt to authenticated;
    grant select on public.usuarios to authenticated;
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  return db;
}

const entrar = (db, email) => db.exec(`update public._jwt set email = '${email}'`);

async function carteiraCom(db, linhas, { venc_de = "2020-01-01", venc_ate = "2030-12-31", nome = "Carteira teste", lote = "Lote 1" } = {}) {
  const id = await um(db,
    `select public.preventivo_carteira_criar($1, null, $2::date, $3::date)`, [nome, venc_de, venc_ate]);
  const resumo = await um(db,
    `select public.preventivo_lote_confirmar($1::uuid, $2, 'arquivo.xlsx', '{}'::jsonb, null, $3::jsonb)`,
    [id, lote, JSON.stringify(linhas)]);
  return { id, resumo };
}

// Uma linha de arquivo com tudo válido; cada teste muda só o que interessa.
const linha = (over = {}) => ({
  matricula: "2026000001", documento: "9000001", aluno_nome: "Fulana de Tal",
  cpf: "00000000191", competencia: "2026/2", vencimento: "2026-09-25",
  valor: "500.00", saldo: "500.00", situacao: "EM ABERTO",
  celular: "(51) 99999-0001", email: "fulana@exemplo.com", ...over,
});

// Extrato do Prime como a Edge Function entrega: já reduzido aos campos usados.
const extrato = (over = {}) => ({
  documento: "9000001", vencimento: "2026-09-25", valor_liquido: "500.00",
  valor_bruto: "500.00", valor_corrigido: "1000.00", liquidado_em: "2026-09-20",
  portador: "95", portador_nome: "SANTANDER CC", ...over,
});

describe("Preventivo — acesso restrito à gestão", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("Amanda ADM não cria carteira, mesmo estando ativa no sistema", async () => {
    await entrar(db, OUTRA);
    await expect(
      um(db, `select public.preventivo_carteira_criar('x', null, '2026-01-01'::date, '2026-12-31'::date)`)
    ).rejects.toThrow(/restrito à gestão/);
  });

  it("usuário desativado não passa, mesmo sendo o e-mail certo", async () => {
    await db.exec(`update public.usuarios set ativo = false where email = '${GESTAO}'`);
    expect(await um(db, `select public.preventivo_e_gestao()`)).toBe(false);
  });

  it("a trava não é só da tela: outro usuário não lê a tabela direto", async () => {
    await carteiraCom(db, [linha()]);
    await entrar(db, OUTRA);
    await db.exec(`set role authenticated`);
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(0);
    await db.exec(`reset role`);
  });

  it("a gestão lê a mesma tabela normalmente", async () => {
    await carteiraCom(db, [linha()]);
    await db.exec(`set role authenticated`);
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(1);
    await db.exec(`reset role`);
  });
});

describe("Preventivo — importação", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("a prévia não grava nada", async () => {
    const id = await um(db, `select public.preventivo_carteira_criar('C', null, '2020-01-01'::date, '2030-12-31'::date)`);
    const r = await um(db, `select public.preventivo_lote_previa($1::uuid, $2::jsonb)`,
      [id, JSON.stringify([linha()])]);
    expect(r.linhas_aceitas).toBe(1);
    expect(r.novos).toBe(1);
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(0);
    expect(await um(db, `select count(*)::int from public.prev_lote`)).toBe(0);
  });

  it("reimportar o mesmo arquivo não duplica título nem valor", async () => {
    const { id } = await carteiraCom(db, [linha(), linha({ documento: "9000002", valor: "300.00", saldo: "300.00" })]);
    await um(db, `select public.preventivo_lote_confirmar($1::uuid, 'Lote 2', 'arquivo.xlsx', '{}'::jsonb, null, $2::jsonb)`,
      [id, JSON.stringify([linha(), linha({ documento: "9000002", valor: "300.00", saldo: "300.00" })])]);
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(2);
    expect(Number(await um(db, `select sum(saldo_inicial) from public.prev_titulo`))).toBe(800);
  });

  it("o valor de entrada da carteira não é reescrito por reimportação com outro valor", async () => {
    const { id } = await carteiraCom(db, [linha()]);
    await um(db, `select public.preventivo_lote_confirmar($1::uuid, 'Lote 2', 'a.xlsx', '{}'::jsonb, null, $2::jsonb)`,
      [id, JSON.stringify([linha({ valor: "777.00", saldo: "777.00" })])]);
    expect(Number(await um(db, `select saldo_inicial from public.prev_titulo`))).toBe(500);
    expect(Number(await um(db, `select valor_original from public.prev_titulo`))).toBe(777);
  });

  it("um título em dois lotes conta uma vez só no consolidado", async () => {
    const { id } = await carteiraCom(db, [linha()]);
    await um(db, `select public.preventivo_lote_confirmar($1::uuid, 'Lote 2', 'a.xlsx', '{}'::jsonb, null, $2::jsonb)`,
      [id, JSON.stringify([linha()])]);
    expect(await um(db, `select count(*)::int from public.prev_titulo_lote`)).toBe(2);
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [id]);
    expect(res.totais.titulos).toBe(1);
    expect(Number(res.totais.valor_inicial)).toBe(500);
  });

  it("linha sem matrícula é recusada com motivo, e o nome nunca vira chave", async () => {
    const { resumo } = await carteiraCom(db, [linha(), linha({ matricula: "", documento: "9000009" })]);
    expect(resumo.linhas_recusadas).toBe(1);
    expect(resumo.recusas_por_motivo.SEM_MATRICULA).toBe(1);
  });

  it("linha repetida no arquivo entra uma vez e a segunda é separada", async () => {
    const { resumo } = await carteiraCom(db, [linha(), linha()]);
    expect(resumo.recusas_por_motivo.DUPLICADA_NO_ARQUIVO).toBe(1);
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(1);
  });

  it("mesmo documento em outra matrícula não funde título: recusa", async () => {
    const { id } = await carteiraCom(db, [linha()]);
    const r = await um(db, `select public.preventivo_lote_previa($1::uuid, $2::jsonb)`,
      [id, JSON.stringify([linha({ matricula: "2026000999" })])]);
    expect(r.recusas_por_motivo.DOCUMENTO_EM_OUTRA_MATRICULA).toBe(1);
  });

  it("registro fora da janela de vencimento da carteira é recusado", async () => {
    const { resumo } = await carteiraCom(db, [linha({ vencimento: "2019-01-10" })],
      { venc_de: "2026-09-01", venc_ate: "2026-09-30" });
    expect(resumo.recusas_por_motivo.FORA_DO_PERIODO).toBe(1);
  });

  it("telefone fixo e número incompleto não viram celular, e a prévia conta isso", async () => {
    const { resumo } = await carteiraCom(db, [
      linha({ celular: "(51) 3333-4444" }),
      linha({ documento: "9000002", celular: "999" }),
      linha({ documento: "9000003", celular: "+55 51 98888-7777" }),
    ]);
    expect(resumo.sem_celular_valido).toBe(2);
    expect(await um(db, `select celular from public.prev_titulo where documento = '9000003'`)).toBe("5551988887777");
  });

  it("e-mail inválido é separado, não corrigido", async () => {
    const { resumo } = await carteiraCom(db, [linha({ email: "fulana(arroba)exemplo" })]);
    expect(resumo.sem_email_valido).toBe(1);
    expect(await um(db, `select email from public.prev_titulo`)).toBe(null);
  });

  it("a prévia avisa quando o mesmo número aparece para alunos diferentes", async () => {
    const { resumo } = await carteiraCom(db, [
      linha(),
      linha({ matricula: "2026000002", documento: "9000002", aluno_nome: "Sicrano" }),
    ]);
    expect(resumo.celular_compartilhado).toBe(2);
  });
});

describe("Preventivo — janela de 31 dias em America/Sao_Paulo", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("31 dias ainda é preventivo; 32 não é mais", async () => {
    const hoje = await um(db, `select public.preventivo_hoje()`);
    expect(await um(db, `select public.preventivo_na_janela(($1::date - 31))`, [hoje])).toBe(true);
    expect(await um(db, `select public.preventivo_na_janela(($1::date - 32))`, [hoje])).toBe(false);
    expect(await um(db, `select public.preventivo_na_janela(($1::date + 10))`, [hoje])).toBe(true);
  });

  it("quem passou de 31 dias sai das ações novas e mantém o histórico", async () => {
    const hoje = await um(db, `select public.preventivo_hoje()`);
    const venc = new Date(hoje); venc.setDate(venc.getDate() - 40);
    const iso = venc.toISOString().slice(0, 10);
    const { id } = await carteiraCom(db, [linha({ vencimento: iso })]);
    await um(db, `select public.preventivo_janela_aplicar()`);
    expect(await um(db, `select status from public.prev_titulo`)).toBe("FORA_DA_JANELA");
    // histórico preservado: o título continua na carteira e no consolidado
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [id]);
    expect(res.totais.titulos).toBe(1);
    expect(res.totais.fora_da_janela).toBe(1);
  });

  it("o fuso é o de São Paulo, não o do servidor", async () => {
    const sp = await um(db, `select public.preventivo_hoje()`);
    const esperado = await um(db, `select ((now() at time zone 'America/Sao_Paulo')::date)`);
    expect(String(sp)).toBe(String(esperado));
  });
});

describe("Preventivo — sincronização com o Prime", () => {
  let db, carteira, titulo;

  beforeEach(async () => {
    db = await novoBanco();
    const c = await carteiraCom(db, [linha()]);
    carteira = c.id;
    titulo = await um(db, `select id from public.prev_titulo`);
  });

  const ciclo = async (linhas) => {
    const sinc = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', $2::jsonb)`,
      [sinc, JSON.stringify(linhas)]);
    await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [sinc]);
    return sinc;
  };

  it("o primeiro ciclo é linha de base: grava foto e não inventa movimento", async () => {
    await ciclo([extrato()]);
    expect(await um(db, `select count(*)::int from public.prev_titulo_snapshot`)).toBe(1);
    expect(await um(db, `select count(*)::int from public.prev_evento`)).toBe(0);
    expect(Number(await um(db, `select saldo_atual from public.prev_titulo`))).toBe(500);
  });

  it("queda de saldo vira REDUÇÃO OBSERVADA, nunca pagamento", async () => {
    await ciclo([extrato()]);
    await ciclo([extrato({ valor_liquido: "200.00" })]);
    const ev = (await db.query(`select tipo, valor_delta, e_pagamento_comprovado from public.prev_evento`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].tipo).toBe("REDUCAO_SALDO_OBSERVADA");
    expect(Number(ev[0].valor_delta)).toBe(300);
    expect(ev[0].e_pagamento_comprovado).toBe(false);
  });

  it("saldo zerado é QUITAÇÃO OBSERVADA, e o painel não a chama de recebimento", async () => {
    await ciclo([extrato()]);
    await ciclo([extrato({ valor_liquido: "0" })]);
    expect(await um(db, `select tipo from public.prev_evento`)).toBe("QUITACAO_OBSERVADA");
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira]);
    expect(res.recebido.valor).toBe(null);
    expect(res.recebido.motivo).toMatch(/não expõe evento, data nem valor de pagamento/);
    expect(Number(res.movimento.QUITACAO_OBSERVADA.valor)).toBe(500);
  });

  it("consultar de novo sem mudança não duplica movimento", async () => {
    await ciclo([extrato()]);
    await ciclo([extrato({ valor_liquido: "200.00" })]);
    await ciclo([extrato({ valor_liquido: "200.00" })]);
    await ciclo([extrato({ valor_liquido: "200.00" })]);
    expect(await um(db, `select count(*)::int from public.prev_evento`)).toBe(1);
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira]);
    expect(Number(res.reconciliacao.reducao_observada)).toBe(300);
  });

  it("sumir do extrato não é recebimento e não apaga o saldo conhecido", async () => {
    await ciclo([extrato()]);
    await ciclo([]);
    expect(await um(db, `select tipo from public.prev_evento`)).toBe("AUSENTE_NO_EXTRATO");
    expect(Number(await um(db, `select saldo_atual from public.prev_titulo`))).toBe(500);
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira]);
    expect(res.movimento.REDUCAO_SALDO_OBSERVADA).toBeUndefined();
    expect(res.movimento.QUITACAO_OBSERVADA).toBeUndefined();
    expect(res.totais.ausentes_no_extrato).toBe(1);
  });

  it("aumento de saldo entra separado, não abate recebimento", async () => {
    await ciclo([extrato()]);
    await ciclo([extrato({ valor_liquido: "560.00" })]);
    const res = await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira]);
    expect(Number(res.movimento.AUMENTO_SALDO_OBSERVADO.valor)).toBe(60);
    expect(res.movimento.REDUCAO_SALDO_OBSERVADA).toBeUndefined();
  });

  it("falha de consulta preserva o dado anterior e não conclui o ciclo como sucesso", async () => {
    await ciclo([extrato()]);
    const sinc = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await um(db, `select public.preventivo_sinc_falhou($1::uuid, '2026000001', 'prime 503')`, [sinc]);
    const fim = await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [sinc]);
    expect(fim.status).toBe("FALHOU");
    expect(Number(await um(db, `select saldo_atual from public.prev_titulo`))).toBe(500);
    const sit = await um(db, `select public.preventivo_sinc_situacao($1::uuid)`, [carteira]);
    expect(sit.ultima_completa).not.toBe(null);
    expect(sit.ultima_tentativa.status).toBe("FALHOU");
  });

  it("payload fora da forma esperada é erro, nunca 'extrato vazio'", async () => {
    const sinc = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await expect(
      um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', '{"items":null}'::jsonb)`, [sinc])
    ).rejects.toThrow(/fora da forma esperada/);
  });

  it("duas atualizações ao mesmo tempo não existem", async () => {
    await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await expect(
      um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira])
    ).rejects.toThrow(/já existe uma atualização em andamento/i);
  });

  it("o movimento é por TÍTULO: pagar um não mexe no outro do mesmo aluno", async () => {
    await um(db, `select public.preventivo_lote_confirmar($1::uuid, 'Lote 2', 'a.xlsx', '{}'::jsonb, null, $2::jsonb)`,
      [carteira, JSON.stringify([linha({ documento: "9000002", valor: "400.00", saldo: "400.00" })])]);
    await ciclo([extrato(), extrato({ documento: "9000002", valor_liquido: "400.00" })]);
    await ciclo([extrato({ valor_liquido: "0" }), extrato({ documento: "9000002", valor_liquido: "400.00" })]);
    expect(Number(await um(db, `select saldo_atual from public.prev_titulo where documento = '9000002'`))).toBe(400);
    expect(await um(db, `select count(*)::int from public.prev_evento`)).toBe(1);
  });

  it("a conta do painel fecha: inicial − redução + aumento = saldo atual", async () => {
    await ciclo([extrato()]);
    await ciclo([extrato({ valor_liquido: "120.00" })]);
    const r = (await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira])).reconciliacao;
    const fechamento = Number(r.valor_inicial) - Number(r.reducao_observada) + Number(r.aumento_observado);
    expect(fechamento).toBeCloseTo(Number(r.saldo_atual), 2);
  });
});

describe("Preventivo — ações e exportação", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    const c = await carteiraCom(db, [
      linha(),
      linha({ matricula: "2026000002", documento: "9000002", aluno_nome: "Sicrano",
              celular: "(51) 3333-4444", email: "sicrano@exemplo.com" }),
      linha({ matricula: "2026000003", documento: "9000003", aluno_nome: "Beltrana",
              celular: "(51) 97777-0003", email: "beltrana@exemplo.com" }),
    ]);
    carteira = c.id;
  });

  const preparar = (nome, canal, filtros = {}) =>
    um(db, `select public.preventivo_acao_preparar($1::uuid, $2, $3, $4::jsonb)`,
      [carteira, nome, canal, JSON.stringify(filtros)]);

  it("quem não tem celular válido fica separado com o motivo, e não entra no arquivo", async () => {
    const r = await preparar("Aviso 1", "WHATSAPP");
    expect(r.incluidos).toBe(2);
    expect(r.separados.SEM_CELULAR_VALIDO).toBe(1);
    const fora = await um(db, `select public.preventivo_acao_publico($1::uuid, false)`, [r.id]);
    expect(fora.find((x) => x.aluno === "Sicrano").motivo).toBe("SEM_CELULAR_VALIDO");
  });

  it("número compartilhado por alunos diferentes não entra para nenhum dos dois", async () => {
    await um(db, `update public.prev_titulo set celular = '5551977770003' where documento = '9000001'`);
    const r = await preparar("Aviso 2", "WHATSAPP");
    expect(r.separados.CONTATO_COMPARTILHADO_COM_OUTRO_ALUNO).toBe(2);
    expect(r.incluidos).toBe(0);
  });

  it("um celular por aluno: dois títulos do mesmo aluno viram um destinatário", async () => {
    await um(db, `select public.preventivo_lote_confirmar($1::uuid, 'Lote 2', 'a.xlsx', '{}'::jsonb, null, $2::jsonb)`,
      [carteira, JSON.stringify([linha({ documento: "9000010", valor: "100.00", saldo: "100.00" })])]);
    const r = await preparar("Aviso 3", "WHATSAPP");
    expect(r.alunos).toBe(r.incluidos);
    expect(r.separados.OUTRO_TITULO_DO_MESMO_ALUNO_JA_NO_PUBLICO).toBe(1);
  });

  it("o número exportado é 55 + DDD + celular, só dígitos", async () => {
    const r = await preparar("Aviso 4", "WHATSAPP");
    const publico = await um(db, `select public.preventivo_acao_publico($1::uuid, true)`, [r.id]);
    for (const p of publico) expect(p.contato).toMatch(/^55\d{2}9\d{8}$/);
  });

  it("título fora da janela preventiva não entra em ação nova", async () => {
    const hoje = await um(db, `select public.preventivo_hoje()`);
    await um(db, `update public.prev_titulo set vencimento = ($1::date - 60) where documento = '9000003'`, [hoje]);
    await um(db, `select public.preventivo_janela_aplicar()`);
    const r = await preparar("Aviso 5", "WHATSAPP");
    expect(r.separados.FORA_DA_JANELA_PREVENTIVA).toBe(1);
  });

  it("título com saldo zerado não é cobrado de novo", async () => {
    await um(db, `update public.prev_titulo set saldo_atual = 0 where documento = '9000003'`);
    const r = await preparar("Aviso 6", "WHATSAPP");
    expect(r.separados.SALDO_ZERADO).toBe(1);
  });

  it("situação cancelada na origem fica de fora", async () => {
    await um(db, `update public.prev_titulo set situacao_origem = 'CANCELADO' where documento = '9000003'`);
    const r = await preparar("Aviso 7", "WHATSAPP");
    expect(r.separados.SITUACAO_CANCELADA_NA_ORIGEM).toBe(1);
  });

  it("no e-mail o corte é o e-mail, não o celular", async () => {
    await um(db, `update public.prev_titulo set email = null where documento = '9000003'`);
    const r = await preparar("Aviso 8", "EMAIL");
    expect(r.separados.SEM_EMAIL_VALIDO).toBe(1);
    expect(r.separados.SEM_CELULAR_VALIDO).toBeUndefined();
  });

  it("exportar não é enviar: a ordem dos estados é obrigatória", async () => {
    const r = await preparar("Aviso 9", "WHATSAPP");
    await expect(
      um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [r.id])
    ).rejects.toThrow(/depois de exportar/);
    await um(db, `select public.preventivo_acao_marcar($1::uuid, 'EXPORTADA')`, [r.id]);
    const fim = await um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [r.id]);
    expect(fim.estado).toBe("ENVIO_CONFIRMADO");
    expect(fim.envio_confirmado_em).not.toBe(null);
  });

  it("a ação guarda qual foto financeira estava na tela quando o público foi montado", async () => {
    const sinc = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    // os TRÊS alunos da carteira precisam ser consultados: ciclo com aluno
    // pendente não vira "atualizado com sucesso", e é isso que a ação exibe.
    for (const [m, doc] of [["2026000001", "9000001"], ["2026000002", "9000002"], ["2026000003", "9000003"]]) {
      await um(db, `select public.preventivo_sinc_gravar($1::uuid, $2, $3::jsonb)`,
        [sinc, m, JSON.stringify([extrato({ documento: doc })])]);
    }
    await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [sinc]);
    const r = await preparar("Aviso 10", "WHATSAPP");
    expect(r.atualizacao_financeira.sinc_id).toBe(sinc);
    expect(r.atualizacao_financeira.em).not.toBe(null);
  });

  it("o mesmo pagamento não é somado duas vezes quando o título está em duas ações", async () => {
    const a1 = await preparar("Aviso A", "WHATSAPP");
    const a2 = await preparar("Aviso B", "WHATSAPP");
    for (const a of [a1, a2]) {
      await um(db, `select public.preventivo_acao_marcar($1::uuid, 'EXPORTADA')`, [a.id]);
      await um(db, `select public.preventivo_acao_marcar($1::uuid, 'ENVIO_CONFIRMADO')`, [a.id]);
    }
    const s1 = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', $2::jsonb)`, [s1, JSON.stringify([extrato()])]);
    await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [s1]);
    const s2 = await um(db, `select public.preventivo_sinc_abrir($1::uuid, 'manual')`, [carteira]);
    await um(db, `select public.preventivo_sinc_gravar($1::uuid, '2026000001', $2::jsonb)`,
      [s2, JSON.stringify([extrato({ valor_liquido: "0" })])]);
    await um(db, `select public.preventivo_sinc_concluir($1::uuid, null)`, [s2]);

    const acoes = await um(db, `select public.preventivo_acoes($1::uuid)`, [carteira]);
    const porAcao = acoes.filter((a) => a.nome.startsWith("Aviso "))
      .reduce((s, a) => s + Number(a.movimento_apos_envio?.valor || 0), 0);
    const consolidado = Number((await um(db, `select public.preventivo_resultados($1::uuid)`, [carteira]))
      .reconciliacao.reducao_observada);
    // as duas ações mostram o mesmo movimento; o consolidado conta uma vez só
    expect(porAcao).toBe(1000);
    expect(consolidado).toBe(500);
  });
});

describe("Preventivo — isolamento da cobrança", () => {
  it("nenhuma tabela do Preventivo aponta para tabela da cobrança", async () => {
    const db = await novoBanco();
    const r = await db.query(`
      select tc.table_name, ccu.table_name as destino
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_name like 'prev\\_%'`);
    for (const l of r.rows) expect(l.destino).toMatch(/^prev_/);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("nenhuma função do Preventivo escreve fora do prefixo prev_", async () => {
    // comentários saem ANTES da busca: o texto explicativo destas migrations
    // cita `acordos`, `casos` e `parcelas` de propósito.
    const semComentario = MIGRATIONS.join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    // `do update set` do ON CONFLICT não é escrita em tabela nova — o alvo
    // já foi contado no INSERT INTO correspondente.
    const escritas = [...semComentario.matchAll(
      /(?<!\bdo\s)\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((t) => !t.startsWith("prev_") && !t.startsWith("_prev_"));
    expect([...new Set(escritas)]).toEqual([]);
  });
});
