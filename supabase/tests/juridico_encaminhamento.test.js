// JURIDICO -- selecao, conferencia, aprovacao com bloqueio, Excel e confirmacao.
// Migration REAL e rollback REAL num PostgreSQL real (PGlite), sobre a fixture
// confirmacao_d2 (funcoes de producao com texto exato) + o portao canonico
// `aluno_bloqueio_administrativo`. Dados FICTICIOS.
//
// O que estes testes impedem: duplicidade (aluno, titulo ou valor contado duas
// vezes), cobranca depois do bloqueio e encaminhamento indevido de acordo.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20261112180000_juridico_encaminhamento";
const OPERADOR = H.OP6;
let BASE;

// `termos_acordo` nao faz parte da fixture (ela nasceu do fluxo de confirmacao).
// So as colunas que a conferencia le.
const TERMOS = `create table if not exists public.termos_acordo (
  id uuid default gen_random_uuid() primary key, aluno_id text, status text,
  arquivo_nome text, arquivo_url text, etapa_assinatura text,
  arquivo_final_nome text, arquivo_final_url text, criado_em timestamptz default now());`;

beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(TERMOS);
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});

const novo = async (email = H.GESTAO) => {
  const db = H.abrir(BASE);
  await db.exec("set timezone = 'UTC';");
  await H.como(db, email);
  return db;
};
let seq = 0;
const U = (n, k) => `b7000000-0000-4000-8000-${String(n).padStart(6, "0")}${String(k).padStart(6, "0")}`;

// Aluno com mensalidades vencidas em 2025. `acordo`: null | "QUEBRADO" | "EM_DIA".
async function mk(db, { sit = "Formado", valores = [1000], venc = "2025-06-10", acordo = null, semestre = "2025/1", status = "CONTATAR" } = {}) {
  const n = ++seq, al = U(n, 1), cs = U(n, 2), cpf = String(70000000000 + n);
  await db.query(
    "insert into alunos(id,nome,cpf,matricula,curso,situacao_academica,semestre_divida,status_atual,status_jornada,status_acionamento,responsavel_atual_email) values ($1,$2,$3,$4,'Direito',$5,$6,$7,$7,$7,'op1@x')",
    [al, `Aluno Juridico ${String(n).padStart(3, "0")}`, cpf, String(9000 + n), sit, semestre, status]);
  await db.query(
    "insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,operador_nome,status_atual,status_acionamento) values ($1,$2,'Aluno Juridico',$3,$3,'op1@x','Op Um',$4,$4)",
    [cs, al, cpf, status]);
  const titulos = [];
  for (let i = 0; i < valores.length; i++) {
    const t = U(n, 10 + i);
    await db.query(
      "insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,tipo_boleto) values ($1,$2,$3,$4,$5::date,$6,$6,'ABERTO','Cursos de Graduação Presencial')",
      [t, al, cpf, `DOC${n}-${i}`, venc, valores[i]]);
    titulos.push(t);
  }
  let ac = null;
  if (acordo) {
    ac = U(n, 50);
    await db.query(
      "insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo) values ($1,$2,$3,'ATIVO',600,600,2,$4)",
      [ac, al, cpf, 5000 + n]);
    await db.query(
      "insert into parcelas(id,acordo_id,numero,valor,vencimento,status) values ($1,$3,1,300,'2025-08-10',$4),($2,$3,2,300,'2099-01-10','A_VENCER')",
      [U(n, 51), U(n, 52), ac, acordo === "QUEBRADO" ? "VENCIDA" : "A_VENCER"]);
  }
  return { al, cs, cpf, titulos, ac };
}
const rpc = async (db, sql, p = []) => (await db.query(`select ${sql} as j`, p)).rows[0].j;
const gerar = (db, qtd, extra = "") => rpc(db, `public.juridico_lote_gerar($1${extra})`, [qtd]);
const casosDoLote = async (db, lote) =>
  (await db.query("select jc.id, jc.aluno_id, jc.status, jc.grupo, jc.valor_previa from juridico_casos jc where lote_id=$1 and status<>'REMOVIDO' order by criado_em, valor_previa desc", [lote])).rows;
const casoDe = async (db, al) => (await db.query("select * from juridico_casos where aluno_id=$1 and status<>'REMOVIDO'", [al])).rows[0];
const bloqueio = async (db, al) => (await db.query("select public.aluno_bloqueio_administrativo($1) b", [al])).rows[0].b;
const falha = async (p) => { try { await p; return null; } catch (e) { return e; } };

describe("acesso: exclusivo da gestao", () => {
  it("operador e anonimo sao recusados em TODA rpc da aba, e nao leem as tabelas pela API", async () => {
    for (const quem of [OPERADOR, null]) {
      const db = await novo(quem);
      for (const chamada of [
        "public.juridico_painel()", "public.juridico_lote_gerar(5)",
        "(select count(*) from public.juridico_candidatos(5))",
        `public.juridico_caso_aprovar('${U(1, 1)}')`, `public.juridico_caso_remover('${U(1, 1)}','x')`,
        `public.juridico_caso_substituir('${U(1, 1)}','x')`,
        `public.juridico_caso_documento_vincular('${U(1, 1)}','a','b','DRIVE')`,
        `public.juridico_caso_autorizar_documento('${U(1, 1)}','x')`,
        `public.juridico_caso_aprovar_acordo_ativo('${U(1, 1)}','x', array[]::uuid[])`,
        `public.juridico_lote_exportar('${U(1, 1)}')`, `public.juridico_lote_enviar_financeiro('${U(1, 1)}')`,
        `public.juridico_casos_confirmar_juridico(array['${U(1, 1)}']::uuid[])`,
      ]) {
        const e = await falha(db.query(`select ${chamada}`));
        expect(e?.code, chamada).toBe("42501");
      }
      await db.close();
    }
    const db = await novo();
    const g = (await db.query(`select
      bool_or(has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate')
           or has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate')) aberto,
      bool_and(c.relrowsecurity) rls
      from pg_class c where c.relname like 'juridico\\_%' and c.relkind='r'`)).rows[0];
    expect(g).toEqual({ aberto: false, rls: true });
    const f = (await db.query(`select count(*)::int n from pg_proc p where p.proname like '\\_juridico\\_%'
      and has_function_privilege('authenticated', p.oid, 'execute')`)).rows[0];
    expect(f.n).toBe(0);
    await db.close();
  });
});

describe("selecao: prioridade e saldo elegivel", () => {
  it("formado do periodo > formado > trancado > evadido; dentro do grupo, maior saldo primeiro", async () => {
    const db = await novo();
    const evadido = await mk(db, { sit: "Cancelado", valores: [9000] });
    const trancado = await mk(db, { sit: "Trancado", valores: [5000] });
    const formadoMenor = await mk(db, { sit: "Formado", valores: [800], semestre: "2026/1" });
    const formadoMaior = await mk(db, { sit: "Formado", valores: [1500, 500], semestre: "2026/1" });
    const formadoPeriodo = await mk(db, { sit: "Concluído", valores: [300], semestre: "2025/2" });
    await mk(db, { sit: "Matriculado Curso Normal", valores: [99999] }); // nao e candidato

    const linhas = (await db.query("select aluno_id, grupo, prioridade, valor_total from public.juridico_candidatos(10, 2025, 2)")).rows;
    expect(linhas.map((l) => l.aluno_id)).toEqual([formadoPeriodo.al, formadoMaior.al, formadoMenor.al, trancado.al, evadido.al]);
    expect(linhas.map((l) => l.prioridade)).toEqual([1, 2, 2, 3, 4]);
    expect(Number(linhas[1].valor_total)).toBe(2000);

    const soTrancado = (await db.query("select aluno_id from public.juridico_candidatos(10, null, null, array['TRANCADO'])")).rows;
    expect(soTrancado.map((l) => l.aluno_id)).toEqual([trancado.al]);
    await db.close();
  });

  it("fica de fora: titulo anterior a 2025, a vencer, aluno ja bloqueado e aluno com pagamento pendente", async () => {
    const db = await novo();
    const antigo = await mk(db, { valores: [4000], venc: "2024-11-10" });
    const aVencer = await mk(db, { valores: [4000], venc: "2099-01-10" });
    const suspenso = await mk(db, { valores: [4000], status: "SUSPENSAO_COBRANCA" });
    const jaJuridico = await mk(db, { valores: [4000], status: "JURIDICO" });
    const pendente = await mk(db, { valores: [4000] });
    await db.query("insert into solicitacoes_confirmacao_pagamento(aluno_id,status,valor_informado) values ($1,'AGUARDANDO_CONFIRMACAO',500)", [pendente.al]);
    const bom = await mk(db, { valores: [100] });

    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((l) => l.aluno_id);
    expect(ids).toContain(bom.al);
    for (const x of [antigo, aVencer, suspenso, jaJuridico, pendente]) expect(ids).not.toContain(x.al);
    await db.close();
  });

  it("gera a lista preliminar com a quantidade pedida e protocolo; substituir traz o proximo e nao devolve o removido", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [3000] });
    const b = await mk(db, { valores: [2000] });
    const c = await mk(db, { valores: [1000] });
    const r = await gerar(db, 2);
    expect(r.protocolo).toMatch(/^JUR-\d{8}-\d{4}$/);
    expect(r.gerados).toBe(2);
    let cs = await casosDoLote(db, r.lote_id);
    expect(cs.map((x) => x.aluno_id).sort()).toEqual([a.al, b.al].sort());

    const casoA = cs.find((x) => x.aluno_id === a.al);
    const s = await rpc(db, "public.juridico_caso_substituir($1,'jurídico pediu troca')", [casoA.id]);
    expect(s.novo_caso_id).toBeTruthy();
    cs = await casosDoLote(db, r.lote_id);
    expect(cs.map((x) => x.aluno_id).sort()).toEqual([b.al, c.al].sort());

    // nao ha mais ninguem: substituir de novo remove e avisa que nao ha substituto
    const casoB = cs.find((x) => x.aluno_id === b.al);
    const s2 = await rpc(db, "public.juridico_caso_substituir($1,'outra troca')", [casoB.id]);
    expect(s2.novo_caso_id).toBeNull();
    await db.close();
  });
});

describe("duplicidade", () => {
  it("aluno em lote vivo nao entra em outro lote, nem por insercao direta", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [3000] });
    const l1 = await gerar(db, 5);
    const l2 = await gerar(db, 5);
    expect(l1.gerados).toBe(1);
    expect(l2.gerados).toBe(0);
    const e = await falha(db.query(
      "insert into juridico_casos(lote_id,aluno_id,criado_por) values ($1,$2,'x')", [l2.lote_id, a.al]));
    expect(e?.code).toBe("23505");
    await db.close();
  });

  it("mensalidade incorporada a acordo NAO soma: entra a parcela do acordo, nao o titulo", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 700], acordo: "QUEBRADO" });
    // o primeiro titulo foi incorporado ao acordo
    await db.query("insert into acordo_titulo_vinculo(acordo_id,titulo_id,ativo) values ($1,$2,true)", [a.ac, a.titulos[0]]);
    await db.query("update acordos_titulos set situacao='NEGOCIADO' where id=$1", [a.titulos[0]]);

    const conf = await rpc(db, "public._juridico_conferencia($1)", [a.al]);
    expect(Number(conf.total_mensalidades)).toBe(700);
    expect(Number(conf.total_acordos)).toBe(600);
    expect(Number(conf.total)).toBe(1300); // e nao 2300
    expect(conf.incorporadas_qtd).toBe(1);
    expect(conf.acordos[0].situacao).toBe("QUEBRADO");
    await db.close();
  });

  it("titulo ja encaminhado nao e encaminhado de novo (indice unico por titulo e por parcela)", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = (await casosDoLote(db, l.lote_id))[0];
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    const e = await falha(db.query(
      "insert into juridico_casos_titulos(caso_id,aluno_id,tipo,titulo_id,valor) values ($1,$2,'MENSALIDADE',$3,1000)",
      [caso.id, a.al, a.titulos[0]]));
    expect(e?.code).toBe("23505");
    await db.close();
  });
});

describe("encaminhamento indevido de acordo e pendencia documental", () => {
  it("acordo ATIVO em dia exige aprovacao especifica com motivo", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], acordo: "EM_DIA" });
    await db.query("insert into termos_acordo(aluno_id,status,etapa_assinatura,arquivo_final_nome,arquivo_final_url) values ($1,'TERMO_RECEBIDO_LIBERADO','COMPLETO','termo.pdf','termos/x.pdf')", [a.al]);
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);

    const e = await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]));
    expect(e?.message).toMatch(/ACORDO_ATIVO_SEM_APROVACAO/);
    expect(await bloqueio(db, a.al)).toBeNull();

    const semMotivo = await falha(rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'  ',$2)", [caso.id, await ativos(db, caso.aluno_id)]));
    expect(semMotivo?.code).toBe("22023");

    await rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'solicitação expressa do jurídico',$2)", [caso.id, await ativos(db, caso.aluno_id)]);
    const r = await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    expect(r.status).toBe("APROVADO");
    expect(Number(r.valor)).toBe(1600);
    await db.close();
  });

  it("acordo sem termo localizado nao segue; vinculo manual OU autorizacao juridica liberam", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], acordo: "QUEBRADO" });
    const b = await mk(db, { valores: [900], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(2)");
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);

    const painel = await rpc(db, "public.juridico_painel()");
    const visto = painel.casos.find((x) => x.caso_id === ca.id);
    expect(visto.conferencia.termo.status).toBe("NAO_LOCALIZADO");
    expect(visto.pendencias).toEqual(["TERMO_NAO_LOCALIZADO"]);

    expect((await falha(rpc(db, "public.juridico_caso_aprovar($1)", [ca.id])))?.message).toMatch(/TERMO_NAO_LOCALIZADO/);

    await rpc(db, "public.juridico_caso_documento_vincular($1,'Termo assinado na unidade','https://drive.example/termo','PRESENCIAL_DIGITALIZADO')", [ca.id]);
    expect((await rpc(db, "public.juridico_caso_aprovar($1)", [ca.id])).status).toBe("APROVADO");

    await rpc(db, "public.juridico_caso_autorizar_documento($1,'Dra. Fulana autorizou sem termo em 12/11')", [cb.id]);
    expect((await rpc(db, "public.juridico_caso_aprovar($1)", [cb.id])).status).toBe("APROVADO");
    await db.close();
  });

  it("termo anexado mas nao concluido pede validacao; termo completo passa direto", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], acordo: "QUEBRADO" });
    const b = await mk(db, { valores: [900], acordo: "QUEBRADO" });
    await db.query("insert into termos_acordo(aluno_id,status,etapa_assinatura,arquivo_nome,arquivo_url) values ($1,'TERMO_RECEBIDO_LIBERADO','ENVIADO_ASSINATURA','t.pdf','termos/a.pdf')", [a.al]);
    await db.query("insert into termos_acordo(aluno_id,status,etapa_assinatura,arquivo_final_nome,arquivo_final_url) values ($1,'TERMO_LIBERADO_AUTOMATICO_GOV','COMPLETO','f.pdf','termos/b.pdf')", [b.al]);
    await rpc(db, "public.juridico_lote_gerar(2)");
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);
    expect((await falha(rpc(db, "public.juridico_caso_aprovar($1)", [ca.id])))?.message).toMatch(/TERMO_A_VALIDAR/);
    expect((await rpc(db, "public.juridico_caso_aprovar($1)", [cb.id])).status).toBe("APROVADO");
    await db.close();
  });

  it("pagamento que apareceu depois da selecao trava a aprovacao, sem liberacao possivel", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await db.query("insert into solicitacoes_confirmacao_pagamento(aluno_id,status,valor_informado) values ($1,'AGUARDANDO_CONFIRMACAO',500)", [a.al]);
    const e = await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]));
    expect(e?.message).toMatch(/!PAGAMENTO_PENDENTE/);
    await db.close();
  });
});

describe("aprovacao bloqueia a cobranca sem tocar em titulo", () => {
  it("apos aprovar: portao = JURIDICO, caso sai da operacao, e titulo/parcela/acordo ficam identicos", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);

    const foto = async () => ({
      t: (await db.query("select to_jsonb(t) j from acordos_titulos t where aluno_id=$1 order by id", [a.al])).rows,
      p: (await db.query("select to_jsonb(p) j from parcelas p where acordo_id=$1 order by id", [a.ac])).rows,
      a: (await db.query("select to_jsonb(x) j from acordos x where id=$1", [a.ac])).rows,
    });
    const antes = await foto();
    expect(await bloqueio(db, a.al)).toBeNull();

    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);

    // 1. o portao canonico -- lido por elegibilidade, massivas e automaticos
    expect(await bloqueio(db, a.al)).toBe("JURIDICO");
    // 2. o estado que a ficha e a fila leem
    const al = (await db.query("select status_atual, status_jornada, status_acionamento from alunos where id=$1", [a.al])).rows[0];
    expect(al).toEqual({ status_atual: "JURIDICO", status_jornada: "JURIDICO", status_acionamento: "JURIDICO" });
    const cs = (await db.query("select status_atual from casos where id=$1", [a.cs])).rows[0];
    expect(cs.status_atual).toBe("JURIDICO");
    // 3. nenhum titulo cancelado, encerrado ou alterado
    expect(await foto()).toEqual(antes);
    // 4. fotografia do que foi aprovado: 2 mensalidades + 2 parcelas vivas
    const jt = (await db.query("select tipo, count(*)::int n, sum(valor)::numeric v from juridico_casos_titulos where caso_id=$1 and ativo group by tipo order by tipo", [caso.id])).rows;
    expect(jt.map((x) => [x.tipo, x.n, Number(x.v)])).toEqual([["MENSALIDADE", 2, 1500], ["PARCELA_ACORDO", 2, 600]]);
    // 5. historico na ficha
    const mov = (await db.query("select tipo, status_anterior, status_novo from aluno_movimentacoes where aluno_id=$1 and tipo like 'JURIDICO%'", [a.al])).rows;
    expect(mov).toEqual([{ tipo: "JURIDICO_APROVADO", status_anterior: "CONTATAR", status_novo: "JURIDICO" }]);
    // 6. bloqueado nao volta a ser candidato
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((l) => l.aluno_id);
    expect(ids).not.toContain(a.al);
    await db.close();
  });

  it("aprovar duas vezes falha; remover antes do envio devolve o estado anterior e libera os titulos", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], status: "PROMESSA_PAGAMENTO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    expect((await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id])))?.code).toBe("P0001");

    expect((await falha(rpc(db, "public.juridico_caso_remover($1,'')", [caso.id])))?.code).toBe("22023");
    await rpc(db, "public.juridico_caso_remover($1,'jurídico desistiu do caso')", [caso.id]);
    expect(await bloqueio(db, a.al)).toBeNull();
    const al = (await db.query("select status_atual, status_jornada, status_acionamento from alunos where id=$1", [a.al])).rows[0];
    expect(al).toEqual({ status_atual: "PROMESSA_PAGAMENTO", status_jornada: "PROMESSA_PAGAMENTO", status_acionamento: "PROMESSA_PAGAMENTO" });
    expect((await db.query("select status_atual from casos where id=$1", [a.cs])).rows[0].status_atual).toBe("PROMESSA_PAGAMENTO");
    expect((await db.query("select count(*)::int n from juridico_casos_titulos where caso_id=$1 and ativo", [caso.id])).rows[0].n).toBe(0);
    // historico preservado: o caso continua la, como REMOVIDO
    expect((await db.query("select status, removido_motivo from juridico_casos where id=$1", [caso.id])).rows[0])
      .toEqual({ status: "REMOVIDO", removido_motivo: "jurídico desistiu do caso" });
    // e o aluno volta a ser candidato
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((l) => l.aluno_id);
    expect(ids).toContain(a.al);
    await db.close();
  });
});

describe("Excel, envio ao financeiro e confirmacao ao juridico", () => {
  it("o Excel so leva caso aprovado; enviar marca; confirmar exige envio e nao vira ajuizamento", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const b = await mk(db, { valores: [800] });
    const l = await gerar(db, 2);
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);

    // nada aprovado: nao ha o que enviar
    expect((await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id])))?.code).toBe("P0001");

    await rpc(db, "public.juridico_caso_aprovar($1)", [ca.id]);
    // confirmar antes do envio e recusado
    expect((await falha(rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[])", [[ca.id]])))?.code).toBe("P0001");

    const env = await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    expect(env.protocolo).toBe(l.protocolo);
    expect(env.enviados_agora).toBe(1);
    expect(env.casos.map((c) => c.caso_id)).toEqual([ca.id]); // o caso em analise NAO vai
    expect(env.casos[0]).toMatchObject({ cpf: a.cpf, matricula: expect.any(String), situacao_academica: "Formado", status: "ENVIADO_FINANCEIRO" });
    expect(env.casos[0].titulos).toHaveLength(1);
    expect(Number(env.casos[0].titulos[0].valor)).toBe(1000);

    // enviado nao pode mais ser removido pela aba
    expect((await falha(rpc(db, "public.juridico_caso_remover($1,'x')", [ca.id])))?.code).toBe("P0001");
    // reexportar nao muda status e fica registrado
    const exp = await rpc(db, "public.juridico_lote_exportar($1)", [l.lote_id]);
    expect(exp.casos).toHaveLength(1);

    // caso em analise nao e confirmavel
    expect((await falha(rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[])", [[cb.id]])))?.code).toBe("P0001");
    const conf = await rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[], '2026-11-10', 'entregue à Dra. Fulana')", [[ca.id]]);
    expect(conf.confirmados).toBe(1);

    const painel = await rpc(db, "public.juridico_painel()");
    expect(painel.indicadores).toMatchObject({ em_analise: 1, aprovados: 0, enviados_financeiro: 0, confirmados_juridico: 1 });
    expect(Number(painel.indicadores.valor_bloqueado)).toBe(1000);
    const h = (await db.query("select evento, detalhe->>'nota' nota from juridico_historico where caso_id=$1 order by id", [ca.id])).rows;
    expect(h.map((x) => x.evento)).toEqual(["CASO_APROVADO", "ENCAMINHADO_AO_JURIDICO"]);
    expect(h[1].nota).toMatch(/Não indica ajuizamento/);
    // segue bloqueado depois de confirmado
    expect(await bloqueio(db, a.al)).toBe("JURIDICO");
    await db.close();
  });
});

describe("titulo que mudou depois da aprovacao", () => {
  it("pago entre a aprovacao e o envio: o envio e recusado, nada e marcado, e remover libera", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500] });
    const b = await mk(db, { valores: [800], acordo: "QUEBRADO" });
    const l = await gerar(db, 2);
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado')", [cb.id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [ca.id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [cb.id]);

    await db.query("update acordos_titulos set situacao='PAGO' where id=$1", [a.titulos[0]]);
    let e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.code).toBe("P0001");
    expect(e?.message).toMatch(/mudança depois da aprovação/);
    expect((await db.query("select count(*)::int n from juridico_casos where lote_id=$1 and status='ENVIADO_FINANCEIRO'", [l.lote_id])).rows[0].n).toBe(0);

    await rpc(db, "public.juridico_caso_remover($1,'título pago depois da aprovação')", [ca.id]);
    // parcela do acordo paga tambem trava
    await db.query("update parcelas set status='PAGO' where id=$1", [U(Number(b.al.slice(24, 30)), 51)]);
    e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.message).toMatch(/mudança depois da aprovação/);
    await db.close();
  });
});

describe("auditoria: pendencia de pagamento, coluna divergente e valor atual", () => {
  it("pagamento aguardando confirmacao depois da aprovacao trava o envio", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await db.query("insert into solicitacoes_confirmacao_pagamento(aluno_id,status,valor_informado) values ($1,'AGUARDANDO_CONFIRMACAO',500)", [a.al]);
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.message).toMatch(/PAGAMENTO_AGUARDANDO_CONFIRMACAO/);
    await db.close();
  });

  it("valor reduzido depois da aprovacao trava o envio", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    await rpc(db, "public.juridico_caso_aprovar($1)", [(await casoDe(db, a.al)).id]);
    await db.query("update acordos_titulos set saldo_corrigido=100, valor_cobranca_ajustado=null where id=$1", [a.titulos[0]]);
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.code).toBe("P0001");
    await db.close();
  });

  it("retabulacao que tira JURIDICO de uma coluna e recusada; remover libera tudo, inclusive coluna que ficou divergente", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], status: "PROMESSA_PAGAMENTO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    // a retabulacao pela ficha grava so status_atual e status_jornada: recusada
    const e = await falha(db.query("update alunos set status_atual='RETORNO_FINANCEIRO', status_jornada='RETORNO_FINANCEIRO' where id=$1", [a.al]));
    expect(e?.code).toBe("42501");
    // estado legado (coluna divergente, criado antes da guarda): simulado com a guarda desligada
    await db.query("select set_config('juridico.desbloqueio','on',false)");
    await db.query("update alunos set status_acionamento='RETORNO_FINANCEIRO' where id=$1", [a.al]);
    await db.query("select set_config('juridico.desbloqueio','',false)");
    await rpc(db, "public.juridico_caso_remover($1,'desistencia')", [caso.id]);
    expect(await bloqueio(db, a.al)).toBeNull();
    const al = (await db.query("select status_atual, status_jornada, status_acionamento from alunos where id=$1", [a.al])).rows[0];
    // so colunas que ainda eram JURIDICO voltam; a que o operador ja mudou fica como esta
    expect(al).toEqual({ status_atual: "PROMESSA_PAGAMENTO", status_jornada: "PROMESSA_PAGAMENTO", status_acionamento: "RETORNO_FINANCEIRO" });
    await db.close();
  });
});

describe("correcoes da reauditoria (12/11/2026)", () => {
  const pagar = (db, titulo, aluno, cpf) => db.query(
    "insert into pagamentos(aluno_id, titulo_numero, valor_pago, data_pagamento, cpf) values ($1,$2,500,'2026-11-10',$3)",
    [aluno, titulo, cpf]);
  const docDe = async (db, id) => (await db.query("select documento from acordos_titulos where id=$1", [id])).rows[0].documento;
  const alertas = (db, caso) => db.query("select evento from juridico_historico where caso_id=$1 and evento='ALERTA_DIVERGENCIA'", [caso]);

  it("1. pagamento recebido e nao baixado trava a aprovacao e some da selecao", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const b = await mk(db, { valores: [900] });
    await pagar(db, await docDe(db, a.titulos[0]), a.al, a.cpf);
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((x) => x.aluno_id);
    expect(ids).not.toContain(a.al);
    expect(ids).toContain(b.al);
    const l = await gerar(db, 2);
    const ca = await casoDe(db, a.al);
    expect(ca).toBeUndefined(); // nem entrou no lote
    expect(l.gerados).toBe(1);
    await db.close();
  });

  it("2. pagamento depois da aprovacao trava o envio; o caso continua aprovado e nada e marcado", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await pagar(db, await docDe(db, a.titulos[0]), a.al, a.cpf);
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.message).toMatch(/PAGAMENTO_NAO_BAIXADO/);
    expect((await db.query("select status from juridico_casos where id=$1", [caso.id])).rows[0].status).toBe("APROVADO");
    await db.close();
  });

  it("3. pagamento depois do envio: divergencia aparece, alerta e registrado sem apagar historico, e nao repete", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    const antes = (await db.query("select count(*)::int n from juridico_historico where caso_id=$1", [caso.id])).rows[0].n;
    await pagar(db, await docDe(db, a.titulos[0]), a.al, a.cpf);
    const painel = await rpc(db, "public.juridico_painel()");
    expect(painel.casos.find((c) => c.caso_id === caso.id).divergencias).toContain("PAGAMENTO_NAO_BAIXADO");
    expect(await rpc(db, "public.juridico_varrer_alertas()")).toBe(1);
    expect(await rpc(db, "public.juridico_varrer_alertas()")).toBe(0);
    expect((await alertas(db, caso.id)).rows).toHaveLength(1);
    const depois = (await db.query("select count(*)::int n from juridico_historico where caso_id=$1", [caso.id])).rows[0].n;
    expect(depois).toBe(antes + 1);
    expect((await db.query("select evento from juridico_historico where caso_id=$1 and evento='ENCAMINHADO_AO_JURIDICO'", [caso.id])).rows).toHaveLength(0);
    await db.close();
  });

  it("4. pagamento depois da confirmacao gera alerta; data futura e recusada na confirmacao", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    const futura = await falha(rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[], '2999-01-01', null)", [[caso.id]]));
    expect(futura?.code).toBe("22023");
    await rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[], '2026-11-10', null)", [[caso.id]]);
    await pagar(db, await docDe(db, a.titulos[0]), a.al, a.cpf);
    expect(await rpc(db, "public.juridico_varrer_alertas()")).toBe(1);
    const conf = (await db.query("select status from juridico_casos where id=$1", [caso.id])).rows[0].status;
    expect(conf).toBe("CONFIRMADO_JURIDICO");
    await db.close();
  });

  it("5. documentos: cada vinculo fica; historico nao se altera nem se apaga", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_documento_vincular($1,'Termo v1','https://drive.example/v1','DRIVE')", [caso.id]);
    await rpc(db, "public.juridico_caso_documento_vincular($1,'Termo v2 assinado','https://drive.example/v2','PRESENCIAL_DIGITALIZADO')", [caso.id]);
    const docs = (await db.query("select referencia, origem from juridico_documentos where caso_id=$1 order by id", [caso.id])).rows;
    expect(docs.map((d) => d.referencia)).toEqual(["https://drive.example/v1", "https://drive.example/v2"]);
    expect((await falha(db.query("update juridico_documentos set referencia='x'")))?.code).toBe("42501");
    expect((await falha(db.query("delete from juridico_documentos")))?.code).toBe("42501");
    expect((await falha(db.query("update juridico_historico set evento='x'")))?.code).toBe("42501");
    expect((await falha(db.query("truncate juridico_historico")))?.code).toBe("42501");
    expect((await falha(db.query("truncate juridico_documentos")))?.code).toBe("42501");
    await db.close();
  });

  it("6. alteracao indevida de status por qualquer caminho e recusada enquanto o caso esta ativo", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    const tentativas = [
      "update alunos set status_atual='CONTATAR' where id='" + a.al + "'",
      "update alunos set status_jornada='RETORNO_FINANCEIRO' where id='" + a.al + "'",
      "update alunos set status_acionamento='CONTATAR' where id='" + a.al + "'",
      "update casos set status_atual='CONTATAR' where id='" + a.cs + "'",
      "insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,status_atual) values ('" + U(900, 1) + "','" + a.al + "','x','" + a.cpf + "','" + a.cpf + "','op1@x','CONTATAR')",
    ];
    for (const sql of tentativas) {
      const e = await falha(db.query(sql));
      expect(e?.code, sql).toBe("42501");
    }
    expect(await bloqueio(db, a.al)).toBe("JURIDICO");
    await db.close();
  });

  it("7. aluno com encaminhamento ativo nao reentra em lote, nem depois de confirmado", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    await rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[], '2026-11-10', null)", [[caso.id]]);
    const outro = await gerar(db, 5);
    expect(outro.gerados).toBe(0);
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((x) => x.aluno_id);
    expect(ids).not.toContain(a.al);
    await db.close();
  });

  it("8. Término do Contrato nao vira evadido nem entra na selecao de evadidos", async () => {
    const db = await novo();
    const a = await mk(db, { sit: "Término do Contrato", valores: [5000] });
    const b = await mk(db, { sit: "Cancelado", valores: [4000] });
    const evad = (await db.query("select aluno_id, grupo from public.juridico_candidatos(50, null, null, array['EVADIDO'])")).rows.map((x) => x.aluno_id);
    expect(evad).toContain(b.al);
    expect(evad).not.toContain(a.al);
    const todos = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((x) => x.aluno_id);
    expect(todos).not.toContain(a.al);
    await db.close();
  });

  it("9. toda geracao e reexportacao de Excel com CPF fica registrada, inclusive no envio", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    const cont = async () => (await db.query("select count(*)::int n from juridico_historico where lote_id=$1 and evento='EXCEL_GERADO'", [l.lote_id])).rows[0].n;
    await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    expect(await cont()).toBe(1);
    await rpc(db, "public.juridico_lote_exportar($1)", [l.lote_id]);
    expect(await cont()).toBe(2);
    await db.close();
  });

  it("11. o lote enche ate o pedido quando os primeiros candidatos sao barrados", async () => {
    const db = await novo();
    const barrados = [];
    for (let i = 0; i < 3; i++) barrados.push(await mk(db, { valores: [9000 - i] }));
    const ok = [];
    for (let i = 0; i < 2; i++) ok.push(await mk(db, { valores: [100 - i] }));
    for (const b of barrados) await pagar(db, await docDe(db, b.titulos[0]), b.al, b.cpf);
    const l = await gerar(db, 2);
    expect(l.gerados).toBe(2);
    const alunos = (await casosDoLote(db, l.lote_id)).map((x) => x.aluno_id).sort();
    expect(alunos).toEqual(ok.map((x) => x.al).sort());
    await db.close();
  });

  it("12. reexportacao so leva caso ENVIADO; aprovado depois do envio fica fora ate ser enviado", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const b = await mk(db, { valores: [800] });
    const l = await gerar(db, 2);
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [ca.id]);
    await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [cb.id]);
    await db.query("update acordos_titulos set situacao='PAGO' where id=$1", [b.titulos[0]]);
    const exp = await rpc(db, "public.juridico_lote_exportar($1)", [l.lote_id]);
    expect(exp.casos.map((c) => c.caso_id)).toEqual([ca.id]);
    expect(exp.casos[0].divergencias).toEqual([]);
    // mudanca depois do envio sai MARCADA no payload do Excel, com o valor da aprovacao
    await db.query("update acordos_titulos set situacao='PAGO' where id=$1", [a.titulos[0]]);
    const exp2 = await rpc(db, "public.juridico_lote_exportar($1)", [l.lote_id]);
    expect(exp2.casos[0].divergencias).toContain("MENSALIDADE_ALTERADA");
    expect(Number(exp2.casos[0].titulos[0].valor)).toBe(1000);
    await db.close();
  });

  it("13. valor do titulo respeita valor_em_aberto; centavos alem de 2 casas nao viram divergencia falsa", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await db.query("update acordos_titulos set saldo_corrigido=null, valor_em_aberto=800 where id=$1", [a.titulos[0]]);
    const b = await mk(db, { valores: [1000] });
    await db.query("update acordos_titulos set valor_cobranca_ajustado=987.655 where id=$1", [b.titulos[0]]);
    expect(Number((await rpc(db, "public._juridico_conferencia($1)", [a.al])).total)).toBe(800);
    const l = await gerar(db, 2);
    const ca = await casoDe(db, a.al), cb = await casoDe(db, b.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [ca.id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [cb.id]);
    const env = await rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]);
    expect(env.enviados_agora).toBe(2);
    expect(env.casos.map((c) => Number(c.valor_aprovado)).sort()).toEqual([800, 987.66]);
    await db.close();
  });

  it("14. extrato Prime: liquidacao de titulo NEGOCIADO ou dentro do prazo nao barra; a regra por titulo das massivas barra", async () => {
    const db = await novo();
    const extrato = (x, doc, liq) => db.query(
      "insert into prime_extrato(matricula,boleto,cpf,vencimento,liquidado_em,valor_pago) values ($1,$2,$3,'2025-06-10',$4,500)",
      [x.cpf, String(doc).replace(/\D/g, ""), x.cpf, liq]);
    const negociado = await mk(db, { valores: [1000, 700] });
    await db.query("update acordos_titulos set situacao='NEGOCIADO' where id=$1", [negociado.titulos[0]]);
    await extrato(negociado, await docDe(db, negociado.titulos[0]), "2025-09-01");
    const noPrazo = await mk(db, { valores: [1000] });
    await extrato(noPrazo, await docDe(db, noPrazo.titulos[0]), "2025-06-20");
    const pago = await mk(db, { valores: [1000] });
    await db.query("update acordos_titulos set created_at='2025-05-01' where id=$1", [pago.titulos[0]]);
    await extrato(pago, await docDe(db, pago.titulos[0]), "2025-09-01");
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((x) => x.aluno_id);
    expect(ids).toContain(negociado.al);
    expect(ids).toContain(noPrazo.al);
    expect(ids).not.toContain(pago.al);
    await db.close();
  });

  it("15. acordo novo fechado depois da aprovacao vira divergencia e trava o envio", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    const l = await gerar(db, 1);
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo,criado_em) values ($1,$2,$3,'ATIVO',500,500,1,7777, now() + interval '1 minute')", [U(950, 1), a.al, a.cpf]);
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.message).toMatch(/ACORDO_NOVO/);
    await db.close();
  });

  it("10. pagamento que nao esta no titulo nao bloqueia: so o boleto/titulo do aluno conta", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await pagar(db, "NAO-EXISTE-999", a.al, a.cpf);
    const ids = (await db.query("select aluno_id from public.juridico_candidatos(50)")).rows.map((x) => x.aluno_id);
    expect(ids).toContain(a.al);
    await db.close();
  });
});

// Achado 5 (Guardiao): acordo ATIVO criado ou reativado DEPOIS da geracao da lista
// nao entra na aprovacao sem revisao especifica da gestao.
// Limite: o PGlite roda numa unica sessao, entao a corrida real entre duas conexoes
// nao e reproduzida aqui; a protecao contra a corrida e o lock FOR UPDATE do conjunto.
const ativos = async (db, al) =>
  (await db.query("select coalesce(array_agg(id order by id),'{}'::uuid[]) a from acordos where aluno_id=$1 and upper(status)='ATIVO' and duplicado_de is null", [al])).rows[0].a;

describe("acordo novo ou reativado DURANTE o processo (achado 5)", () => {
  const pend = async (db, al) =>
    (await db.query("select public._juridico_pendencias(jc, public._juridico_conferencia(jc.aluno_id)) p from juridico_casos jc where jc.aluno_id=$1 and jc.status<>'REMOVIDO'", [al])).rows[0].p;
  const acordoEm = (db, al, cpf, id, status, criado, num) =>
    db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo,criado_em) values ($1,$2,$3,$4,500,500,1,$5,$6::timestamptz)",
      [id, al, cpf, status, num, criado]);

  it("acordo criado depois da geracao e antes da aprovacao: pendencia, aprovacao recusada", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await acordoEm(db, a.al, a.cpf, U(970, 1), "ATIVO", "2026-11-12", 9001);
    expect(await pend(db, a.al)).toContain("ACORDO_NOVO_APOS_GERACAO");
    const e = await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]));
    expect(e?.message).toMatch(/ACORDO_NOVO_APOS_GERACAO/);
    expect((await db.query("select status from juridico_casos where id=$1", [caso.id])).rows[0].status).toBe("EM_ANALISE");
    await db.close();
  });

  it("acordo CANCELADO na geracao e REATIVADO depois: pendencia, aprovacao recusada", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await acordoEm(db, a.al, a.cpf, U(971, 1), "CANCELADO", "2025-01-01", 9002);
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await db.query("update acordos set status='ATIVO' where id=$1", [U(971, 1)]);
    expect(await pend(db, a.al)).toContain("ACORDO_NOVO_APOS_GERACAO");
    const e = await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]));
    expect(e?.message).toMatch(/ACORDO_NOVO_APOS_GERACAO/);
    await db.close();
  });

  it("so sai com aprovacao especifica (motivo); depois a base revisada inclui o acordo e a aprovacao passa", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);
    await acordoEm(db, a.al, a.cpf, U(972, 1), "ATIVO", "2026-11-12", 9003);
    expect((await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id])))?.message).toMatch(/ACORDO_NOVO_APOS_GERACAO/);
    const semMotivo = await falha(rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'  ',$2)", [caso.id, await ativos(db, caso.aluno_id)]));
    expect(semMotivo).not.toBeNull();
    await rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'revisado pela gestao',$2)", [caso.id, await ativos(db, caso.aluno_id)]);
    expect(await pend(db, a.al)).not.toContain("ACORDO_NOVO_APOS_GERACAO");
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    const c = (await db.query("select status, acordos_aprovados from juridico_casos where id=$1", [caso.id])).rows[0];
    expect(c.status).toBe("APROVADO");
    expect(c.acordos_aprovados).toContain(U(972, 1));
    await db.close();
  });

  it("achado 1: acordo na lista, cancelado e reativado com o MESMO ID ANTES da aprovacao gera pendencia e recusa", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);
    await db.query("update acordos set status='CANCELADO' where id=$1", [a.ac]);
    await db.query("update acordos set status='ATIVO' where id=$1", [a.ac]);
    expect(await pend(db, a.al)).toContain("ACORDO_REATIVADO_APOS_GERACAO");
    const e = await falha(rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]));
    expect(e?.message).toMatch(/ACORDO_REATIVADO_APOS_GERACAO/);
    // liberar exige revisar a lista; depois a aprovacao passa
    await rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'revisado: reativado pelo financeiro',$2)", [caso.id, await ativos(db, a.al)]);
    expect(await pend(db, a.al)).not.toContain("ACORDO_REATIVADO_APOS_GERACAO");
    expect((await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id])).status).toBe("APROVADO");
    // e a divergencia pos-aprovacao NAO acusa o que foi revisado antes da aprovacao
    expect((await db.query("select public._juridico_divergencias(jc) d from juridico_casos jc where jc.id=$1", [caso.id])).rows[0].d).not.toContain("ACORDO_REATIVADO");
    await db.close();
  });

  it("aprovacao de acordo ativo recusa se a lista revisada nao bate com o conjunto vivo", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    const revisados = await ativos(db, a.al);
    await acordoEm(db, a.al, a.cpf, U(973, 1), "ATIVO", "2026-11-12", 9004);
    const e = await falha(rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'motivo',$2)", [caso.id, revisados]));
    expect(e?.message).toMatch(/mudaram desde a revisão/);
    expect((await db.query("select acordo_ativo_aprovado_em from juridico_casos where id=$1", [caso.id])).rows[0].acordo_ativo_aprovado_em).toBeNull();
    await db.close();
  });

  it("regressao: acordo ja existente na geracao NAO gera pendencia nova", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);
    expect(await pend(db, a.al)).not.toContain("ACORDO_NOVO_APOS_GERACAO");
    expect((await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id])).status).toBe("APROVADO");
    await db.close();
  });
});

// ACORDO_NOVO por CONJUNTO registrado na aprovacao (IDs), nunca por data.
describe("acordo novo ou reativado depois da aprovacao", () => {
  const divs = async (db, caso) =>
    (await db.query("select public._juridico_divergencias(jc) d from juridico_casos jc where jc.id=$1", [caso.id])).rows[0].d;
  const acordoEm = (db, al, cpf, id, status, criado, num) =>
    db.query(
      "insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo,criado_em) values ($1,$2,$3,$4,500,500,1,$5,$6::timestamptz)",
      [id, al, cpf, status, num, criado]);

  it("acordo ATIVO novo com criado_em ANTIGO ainda vira ACORDO_NOVO (data nao decide)", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await acordoEm(db, a.al, a.cpf, U(960, 1), "ATIVO", "2019-01-01", 8001);
    expect(await divs(db, caso)).toContain("ACORDO_NOVO");
    await db.close();
  });

  it("acordo CANCELADO na aprovacao e REATIVADO depois vira ACORDO_NOVO; sem reativacao, nao", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await acordoEm(db, a.al, a.cpf, U(961, 1), "CANCELADO", "2025-01-01", 8002);
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    expect(await divs(db, caso)).not.toContain("ACORDO_NOVO");
    await db.query("update acordos set status='ATIVO' where id=$1", [U(961, 1)]);
    expect(await divs(db, caso)).toContain("ACORDO_NOVO");
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [(await db.query("select lote_id from juridico_casos where id=$1", [caso.id])).rows[0].lote_id]));
    expect(e?.message).toMatch(/ACORDO_NOVO/);
    await db.close();
  });

  it("acordo ATIVO ja contemplado na aprovacao NAO gera alerta", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    expect(await divs(db, caso)).not.toContain("ACORDO_NOVO");
    await db.close();
  });

  it("acordo CANCELADO depois da aprovacao, e acordo QUITADO depois da aprovacao, NAO geram alerta", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await acordoEm(db, a.al, a.cpf, U(962, 1), "CANCELADO", "2026-11-12", 8003);
    await acordoEm(db, a.al, a.cpf, U(963, 1), "QUITADO", "2026-11-12", 8004);
    expect(await divs(db, caso)).not.toContain("ACORDO_NOVO");
    await db.close();
  });

  it("acordo ATIVO na aprovacao, CANCELADO depois e REATIVADO com o mesmo ID vira ACORDO_REATIVADO e trava o envio", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000, 500], acordo: "QUEBRADO" });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_autorizar_documento($1,'autorizado pelo jurídico')", [caso.id]);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await db.query("update acordos set status='CANCELADO' where id=$1", [a.ac]);
    expect(await divs(db, caso)).not.toContain("ACORDO_REATIVADO");
    await db.query("update acordos set status='ATIVO' where id=$1", [a.ac]);
    expect(await divs(db, caso)).toContain("ACORDO_REATIVADO");
    expect(await divs(db, caso)).not.toContain("ACORDO_NOVO");
    const hist = (await db.query("select count(*)::int n from juridico_historico where caso_id=$1 and evento='ACORDO_STATUS'", [caso.id])).rows[0].n;
    expect(hist).toBe(2);
    const e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [caso.lote_id]));
    expect(e?.message).toMatch(/ACORDO_REATIVADO/);
    await db.close();
  });

  it("acordo ATIVO com duplicado_de preenchido NAO gera alerta (copia, nao acordo novo)", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo,duplicado_de) values ($1,$2,$3,'ATIVO',500,500,1,8005,$4)", [U(964, 1), a.al, a.cpf, U(964, 2)]);
    expect(await divs(db, caso)).not.toContain("ACORDO_NOVO");
    await db.close();
  });
});

describe("rollback", () => {
  it("recusa com bloqueio ativo; sem bloqueio, remove tudo e guarda copia fechada", async () => {
    const db = await novo();
    const a = await mk(db, { valores: [1000] });
    await rpc(db, "public.juridico_lote_gerar(1)");
    const caso = await casoDe(db, a.al);
    await rpc(db, "public.juridico_caso_aprovar($1)", [caso.id]);
    const e = await falha(db.exec(H.ROLL(M)));
    expect(e?.message).toMatch(/cobranca bloqueada/);
    await db.exec("rollback");

    await rpc(db, "public.juridico_caso_remover($1,'desfazer para rollback')", [caso.id]);
    await db.exec(H.ROLL(M));
    const r = (await db.query(`select
      (select count(*)::int from pg_proc where proname like '%juridico\\_%' and pronamespace='public'::regnamespace) funcs,
      (select count(*)::int from pg_class where relname like 'juridico\\_%') tabelas,
      (select count(*)::int from _backup_juridico_casos_20261112) copia,
      (select bool_or(has_table_privilege('authenticated', oid, 'select')) from pg_class where relname like '\\_backup\\_juridico\\_%') copia_aberta`)).rows[0];
    expect(r).toEqual({ funcs: 0, tabelas: 0, copia: 1, copia_aberta: false });
    expect(await bloqueio(db, a.al)).toBeNull();
    await db.close();
  });
});
