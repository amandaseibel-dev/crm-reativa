// CARTEIRA GERAL — comportamento em PostgreSQL real (PGlite).
//
// O QUE ESTE TESTE PROVA
//  1. as migrations aplicam (se o SQL não compilar, nada aqui roda);
//  2. a Carteira Geral NÃO é a fila livre: nenhuma rotina que pesca em
//     `operador_email IS NULL` a alcança, e o operador não consegue assumir;
//  3. quem não é gestão não vê nem move nada;
//  4. a execução só move o que está na prévia — e recusa o item cujo dono
//     mudou no meio do caminho;
//  5. a auditoria guarda autor, motivo e titularidade anterior e posterior;
//  6. desfazer devolve exatamente ao dono anterior;
//  7. o que é custódia muda e o que é história não.
//
// Dados fictícios. Bancada: fixtures/carteira_geral/bancada.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { montar, semear, como, q1, qn, GESTAO, ADM, OLGA, LUANA, CG } from "./fixtures/carteira_geral/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => {
  db = await montar();
});

const previa = (aluno_ids, destino, email = null, acordos = true) =>
  q1(db, "select public.carteira_geral_previa($1::uuid[], $2, $3, $4, '{}'::jsonb) r", [aluno_ids, destino, email, acordos]);

describe("Carteira Geral — as migrations aplicam e o destino existe", () => {
  it("cria o destino sem criar um login", async () => {
    const u = await q1(db, "select nome, perfil, ativo from public.usuarios where email = $1", [CG]);
    expect(u.nome).toBe("Carteira Geral");
    expect(u.perfil).toBe("carteira");
    // ativo=false é o que mantém a Carteira Geral fora de todo seletor de
    // pessoa da operação (todos filtram ativo = true).
    expect(u.ativo).toBe(false);
    // e o endereço não é uma caixa de e-mail da empresa: ninguém cria senha nele
    expect(CG.endsWith("@reativa.local")).toBe(true);
  });

  it("o flag de distribuição automática nasce ligado para todo mundo", async () => {
    const r = await qn(db, "select email, recebe_distribuicao_automatica d from public.usuarios where perfil = 'operador' order by email");
    expect(r.every((x) => x.d === true)).toBe(true);
  });
});

describe("Carteira Geral — não é a fila livre", () => {
  it("o que está na Carteira Geral some do pool de onde as rotinas pescam", async () => {
    const a = await semear(db, { nome: "ALUNO UM", dono: OLGA });
    await como(db, GESTAO);

    const antes = await qn(db, "select * from public.pool_da_fila_livre()");
    expect(antes).toHaveLength(0); // é da Olga, não está livre

    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await db.query("select public.carteira_geral_mover($1, $2, true)", [p.r.previa_id, "saída da Olga"]);

    const depois = await qn(db, "select * from public.pool_da_fila_livre()");
    expect(depois).toHaveLength(0); // continua fora do pool: não virou NULL
    const caso = await q1(db, "select operador_email from public.casos where id = $1", [a.caso]);
    expect(caso.operador_email).toBe(CG);
  });

  it("operador não consegue assumir o que está na Carteira Geral", async () => {
    const a = await semear(db, { nome: "ALUNO DOIS", dono: OLGA });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await db.query("select public.carteira_geral_mover($1, $2, true)", [p.r.previa_id, "recolhimento"]);

    await como(db, LUANA);
    const r = await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno]);
    expect(r.sucesso).toBe(false);
  });

  it("mandar para a FILA LIVRE devolve à operação — e aí sim o operador assume", async () => {
    const a = await semear(db, { nome: "ALUNO TRES", dono: OLGA });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "FILA_LIVRE");
    await db.query("select public.carteira_geral_mover($1, $2, true)", [p.r.previa_id, "liberar para a fila"]);

    expect(await qn(db, "select * from public.pool_da_fila_livre()")).toHaveLength(1);

    await como(db, LUANA);
    const r = await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno]);
    expect(r.sucesso).toBe(true);
  });
});

describe("Carteira Geral — quem pode", () => {
  it("operador não enxerga o painel", async () => {
    await como(db, OLGA);
    await expect(db.query("select public.carteira_geral_painel('{}'::jsonb)")).rejects.toThrow(/Sem permissao/);
  });

  it("operador não move nada", async () => {
    const a = await semear(db, { nome: "ALUNO QUATRO", dono: OLGA });
    await como(db, OLGA);
    await expect(
      db.query("select public.carteira_geral_previa($1::uuid[], 'CARTEIRA_GERAL', null, true, '{}'::jsonb)", [[a.aluno]])
    ).rejects.toThrow(/Sem permissao/);
  });

  it("a Amanda ADM entra, mesmo com pode_alterar_responsavel = false", async () => {
    // Em produção cobranca07 tem o flag desligado e a RPC antiga da ficha
    // recusa. A Carteira Geral usa calibragem_e_gestao(), que a inclui.
    const flag = await q1(db, "select pode_alterar_responsavel f from public.usuarios where email = $1", [ADM]);
    expect(flag.f).toBe(false);

    const a = await semear(db, { nome: "ALUNO CINCO", dono: OLGA });
    await como(db, ADM);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    expect(p.r.total_alunos).toBe(1);
  });

  it("sem sessão, nada", async () => {
    await como(db, null);
    await expect(db.query("select public.carteira_geral_painel('{}'::jsonb)")).rejects.toThrow();
  });
});

describe("Carteira Geral — prévia", () => {
  it("conta alunos, acordos e valor, e avisa do retorno que será apagado", async () => {
    const a = await semear(db, { nome: "ALUNO SEIS", dono: OLGA, mensalidade: 1000, parcela: 2000 });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL");

    expect(r.total_alunos).toBe(1);
    expect(r.total_acordos).toBe(1);
    expect(Number(r.total_valor)).toBe(3000);
    expect(Number(r.total_mensalidade)).toBe(1000);
    expect(Number(r.total_acordo_valor)).toBe(2000);

    const tipos = r.conflitos.map((c) => c.tipo);
    expect(tipos).toContain("RETORNO_AGENDADO_SERA_LIMPO");
  });

  it("avisa que o acordo de outro dono vai junto", async () => {
    const a = await semear(db, { nome: "ALUNO SETE", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL", null, true);
    expect(r.conflitos.map((c) => c.tipo)).toContain("ACORDO_DE_OUTRO_DONO");
  });

  it("avisa que o acordo FICA para trás quando a opção é desmarcada", async () => {
    const a = await semear(db, { nome: "ALUNO OITO", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL", null, false);
    expect(r.conflitos.map((c) => c.tipo)).toContain("ACORDO_FICA_COM_O_DONO_ATUAL");
  });

  it("recusa destino inexistente e operador inativo", async () => {
    const a = await semear(db, { nome: "ALUNO NOVE", dono: OLGA });
    await como(db, GESTAO);
    await expect(previa([a.aluno], "QUALQUER")).rejects.toThrow(/Destino invalido/);
    await expect(previa([a.aluno], "OPERADOR", "ninguem@aelbra.com.br")).rejects.toThrow(/invalido ou inativo/);
  });

  it("a prévia não move nada", async () => {
    const a = await semear(db, { nome: "ALUNO DEZ", dono: OLGA });
    await como(db, GESTAO);
    await previa([a.aluno], "CARTEIRA_GERAL");
    const caso = await q1(db, "select operador_email from public.casos where id = $1", [a.caso]);
    expect(caso.operador_email).toBe(OLGA);
  });
});

describe("Carteira Geral — execução", () => {
  it("move caso, ficha e acordo, e registra a auditoria completa", async () => {
    const a = await semear(db, { nome: "ALUNO ONZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await q1(db, "select public.carteira_geral_mover($1, $2, true) r", [p.previa_id, "saída da Olga"]);

    expect(r.alunos_movidos).toBe(1);
    expect(r.acordos_movidos).toBe(1);

    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(CG);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(CG);

    const aud = await q1(db, "select * from public.carteira_geral_auditoria where lote_id = $1", [r.lote_id]);
    expect(aud.autor_email).toBe(GESTAO);
    expect(aud.motivo).toBe("saída da Olga");
    expect(aud.caso_de_email).toBe(OLGA);
    expect(aud.caso_para_email).toBe(CG);
    expect(aud.aluno_de_email).toBe(OLGA);
    expect(aud.acordos_movidos).toBe(1);
  });

  it("exige motivo", async () => {
    const a = await semear(db, { nome: "ALUNO DOZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await expect(db.query("select public.carteira_geral_mover($1, '   ', true)", [p.previa_id])).rejects.toThrow(/motivo/i);
  });

  it("a mesma prévia não roda duas vezes", async () => {
    const a = await semear(db, { nome: "ALUNO TREZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await db.query("select public.carteira_geral_mover($1, 'x', true)", [p.previa_id]);
    await expect(db.query("select public.carteira_geral_mover($1, 'x', true)", [p.previa_id])).rejects.toThrow(/ja foi executada/);
  });

  it("recusa o aluno cujo dono mudou entre a prévia e a confirmação", async () => {
    const a = await semear(db, { nome: "ALUNO CATORZE", dono: OLGA });
    const b = await semear(db, { nome: "ALUNO QUINZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno, b.aluno], "CARTEIRA_GERAL");

    // alguém mexeu no aluno A depois da prévia
    await db.query("select internal.set_resp_aluno($1,$2,'Luana','X','y','sistema','sistema')", [a.aluno, LUANA]);

    const { r } = await q1(db, "select public.carteira_geral_mover($1, 'lote', true) r", [p.previa_id]);
    expect(r.alunos_movidos).toBe(1);
    expect(r.total_recusados).toBe(1);
    expect(r.recusados[0].nome).toBe("ALUNO CATORZE");
    // e o aluno recusado continua com quem ficou, não com a Carteira Geral
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(LUANA);
  });

  it("deixar o acordo para trás é uma escolha explícita e visível", async () => {
    const a = await semear(db, { nome: "ALUNO DEZESSEIS", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL", null, false);
    await db.query("select public.carteira_geral_mover($1, 'so o caso', false)", [p.previa_id]);

    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(OLGA);
  });
});

describe("Carteira Geral — o que não muda", () => {
  it("valores, parcelas e títulos ficam intactos", async () => {
    const a = await semear(db, { nome: "ALUNO DEZESSETE", dono: OLGA, mensalidade: 1234.56, parcela: 999.99 });
    const antes = await q1(db, `select
        (select round(sum(valor),2) from public.parcelas p join public.acordos ac on ac.id=p.acordo_id where ac.aluno_id=$1) parcelas,
        (select round(sum(saldo_corrigido),2) from public.acordos_titulos where aluno_id=$1) titulos,
        (select round(sum(valor_total),2) from public.acordos where aluno_id=$1) acordos`, [a.aluno]);

    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await db.query("select public.carteira_geral_mover($1,'x',true)", [p.previa_id]);

    const depois = await q1(db, `select
        (select round(sum(valor),2) from public.parcelas p join public.acordos ac on ac.id=p.acordo_id where ac.aluno_id=$1) parcelas,
        (select round(sum(saldo_corrigido),2) from public.acordos_titulos where aluno_id=$1) titulos,
        (select round(sum(valor_total),2) from public.acordos where aluno_id=$1) acordos`, [a.aluno]);
    expect(depois).toEqual(antes);
  });

  it("o histórico de quem mexeu continua no lugar e ganha a nova movimentação", async () => {
    const a = await semear(db, { nome: "ALUNO DEZOITO", dono: OLGA });
    await db.query(
      "insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,registrado_por_email) values ($1,'ACIONAMENTO','Olga negociou',$2)",
      [a.aluno, OLGA]
    );

    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await db.query("select public.carteira_geral_mover($1,'x',true)", [p.previa_id]);

    const movs = await qn(db, "select tipo, registrado_por_email from public.aluno_movimentacoes where aluno_id=$1 order by id", [a.aluno]);
    expect(movs[0]).toEqual({ tipo: "ACIONAMENTO", registrado_por_email: OLGA });
    expect(movs.some((m) => m.tipo === "CARTEIRA_GERAL_REMANEJAMENTO")).toBe(true);
  });
});

describe("Carteira Geral — desfazer", () => {
  it("devolve caso, ficha e acordo ao dono anterior", async () => {
    const a = await semear(db, { nome: "ALUNO DEZENOVE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await q1(db, "select public.carteira_geral_mover($1,'x',true) r", [p.previa_id]);

    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(1);
    expect(d.acordos_devolvidos).toBe(1);

    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(OLGA);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(OLGA);
  });

  it("desfazer duas vezes não faz nada na segunda", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await q1(db, "select public.carteira_geral_mover($1,'x',true) r", [p.previa_id]);
    await db.query("select public.carteira_geral_desfazer_lote($1,'engano')", [r.lote_id]);
    const { r: d2 } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'de novo') r", [r.lote_id]);
    expect(d2.alunos_devolvidos).toBe(0);
  });

  it("a auditoria é append-only: não se apaga e não se reescreve", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE E UM", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await q1(db, "select public.carteira_geral_mover($1,'x',true) r", [p.previa_id]);

    await expect(db.query("delete from public.carteira_geral_auditoria where lote_id=$1", [r.lote_id])).rejects.toThrow(/append-only/);
    await expect(db.query("update public.carteira_geral_auditoria set motivo='outro' where lote_id=$1", [r.lote_id])).rejects.toThrow(/append-only/);
    // só a marca de desfeito pode mudar
    await db.query("update public.carteira_geral_auditoria set desfeito_em=now() where lote_id=$1", [r.lote_id]);
  });
});

describe("Carteira Geral — interruptor de distribuição automática", () => {
  it("a gestão desliga e liga, com registro na auditoria", async () => {
    await como(db, GESTAO);
    await db.query("select public.carteira_geral_definir_distribuicao($1, false, 'saída da Olga')", [OLGA]);

    const u = await q1(db, "select recebe_distribuicao_automatica d from public.usuarios where email=$1", [OLGA]);
    expect(u.d).toBe(false);

    const log = await q1(db, "select detalhes from public.auditoria where acao='CARTEIRA_GERAL_DISTRIBUICAO'");
    expect(log.detalhes.operador).toBe("Olga");
    expect(log.detalhes.motivo).toBe("saída da Olga");

    await db.query("select public.carteira_geral_definir_distribuicao($1, true, 'voltou')", [OLGA]);
    expect((await q1(db, "select recebe_distribuicao_automatica d from public.usuarios where email=$1", [OLGA])).d).toBe(true);
  });

  it("operador não mexe nisso", async () => {
    await como(db, OLGA);
    await expect(db.query("select public.carteira_geral_definir_distribuicao($1,false,'x')", [OLGA])).rejects.toThrow(/Sem permissao/);
  });
});
