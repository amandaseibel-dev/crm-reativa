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
        `public.juridico_caso_aprovar_acordo_ativo('${U(1, 1)}','x')`,
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

    const semMotivo = await falha(rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'  ')", [caso.id]));
    expect(semMotivo?.code).toBe("22023");

    await rpc(db, "public.juridico_caso_aprovar_acordo_ativo($1,'solicitação expressa do jurídico')", [caso.id]);
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
    const conf = await rpc(db, "public.juridico_casos_confirmar_juridico($1::uuid[], '2026-11-20', 'entregue à Dra. Fulana')", [[ca.id]]);
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
    expect(e?.message).toMatch(/mudou depois da aprovação/);
    expect((await db.query("select count(*)::int n from juridico_casos where lote_id=$1 and status='ENVIADO_FINANCEIRO'", [l.lote_id])).rows[0].n).toBe(0);

    await rpc(db, "public.juridico_caso_remover($1,'título pago depois da aprovação')", [ca.id]);
    // parcela do acordo paga tambem trava
    await db.query("update parcelas set status='PAGO' where id=$1", [U(Number(b.al.slice(24, 30)), 51)]);
    e = await falha(rpc(db, "public.juridico_lote_enviar_financeiro($1)", [l.lote_id]));
    expect(e?.message).toMatch(/mudou depois da aprovação/);
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
