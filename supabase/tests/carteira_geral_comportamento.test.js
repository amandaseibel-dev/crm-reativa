// CARTEIRA GERAL — comportamento em PostgreSQL real (PGlite).
//
// O QUE ESTE TESTE PROVA
//  1. as migrations aplicam — inclusive a blindagem, com os 10 patches
//     ancorados sobre as rotinas (se algum SQL não compilar, nada aqui roda);
//  2. a Carteira Geral NÃO é a fila livre: nenhuma rotina que pesca em
//     `operador_email IS NULL` a alcança, e o operador não consegue assumir;
//  3. o AGENDAMENTO DE RETORNO sobrevive à troca de custódia — data, hora,
//     origem e a agenda apontando para o novo responsável;
//  4. acordo de terceiro NÃO vai junto por padrão: só por seleção explícita;
//  5. a execução revalida titularidade E estado dos acordos congelados;
//  6. o desfazer recusa o que foi mexido depois do lote, sem atropelar;
//  7. o operador desligado não recebe distribuição NEM assume da fila livre;
//  8. a PERMISSÃO fecha: rodando como `authenticated` (não como dono do banco),
//     o heartbeat do receptivo funciona e o schema `internal` segue fechado.
//
// Dados fictícios. Bancada: fixtures/carteira_geral/bancada.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { montar, semear, como, comoPapel, voltarDono, q1, qn, GESTAO, FERNANDA, ADM, OLGA, LUANA, CG } from "./fixtures/carteira_geral/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => {
  db = await montar();
});

// A prévia congela o plano; a execução só o executa.
const previa = (aluno_ids, destino, { email = null, acordosDoDono = true, acordoIds = [] } = {}) =>
  q1(db, "select public.carteira_geral_previa($1::uuid[], $2, $3, $4, '{}'::jsonb, $5::uuid[]) r",
     [aluno_ids, destino, email, acordosDoDono, acordoIds]);
const mover = (previa_id, motivo = "teste") =>
  q1(db, "select public.carteira_geral_mover($1, $2) r", [previa_id, motivo]);

describe("Carteira Geral — as migrations aplicam e o destino existe", () => {
  it("cria o destino sem criar um login", async () => {
    const u = await q1(db, "select nome, perfil, ativo from public.usuarios where email = $1", [CG]);
    expect(u.nome).toBe("Carteira Geral");
    expect(u.perfil).toBe("carteira");
    // ativo=false é o que mantém a Carteira Geral fora de todo seletor de
    // pessoa da operação (todos filtram ativo = true).
    expect(u.ativo).toBe(false);
    expect(CG.endsWith("@reativa.local")).toBe(true);
  });

  it("todo operador nasce recebendo caso novo", async () => {
    const r = await qn(db, "select email, recebe_novos_casos d from public.usuarios where perfil = 'operador' order by email");
    expect(r.every((x) => x.d === true)).toBe(true);
  });
});

describe("Carteira Geral — não é a fila livre", () => {
  it("o que está na Carteira Geral some do pool de onde as rotinas pescam", async () => {
    const a = await semear(db, { nome: "ALUNO UM", dono: OLGA });
    await como(db, GESTAO);

    expect(await qn(db, "select * from public.pool_da_fila_livre()")).toHaveLength(0);

    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.r.previa_id, "saída da Olga");

    // continua fora do pool: não virou NULL
    expect(await qn(db, "select * from public.pool_da_fila_livre()")).toHaveLength(0);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
  });

  it("operador não consegue assumir o que está na Carteira Geral", async () => {
    const a = await semear(db, { nome: "ALUNO DOIS", dono: OLGA });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.r.previa_id, "recolhimento");

    await como(db, LUANA);
    const r = await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno]);
    expect(r.sucesso).toBe(false);
  });

  it("mandar para a FILA LIVRE devolve à operação — e aí sim o operador assume", async () => {
    const a = await semear(db, { nome: "ALUNO TRES", dono: OLGA });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "FILA_LIVRE");
    await mover(p.r.previa_id, "liberar para a fila");

    expect(await qn(db, "select * from public.pool_da_fila_livre()")).toHaveLength(1);

    await como(db, LUANA);
    expect((await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno])).sucesso).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// O compromisso com o aluno não pode morrer numa troca de fila.
// ---------------------------------------------------------------------------
describe("Carteira Geral — o retorno agendado sobrevive à troca de custódia", () => {
  it("preserva data, hora e origem do retorno na ficha do aluno", async () => {
    const a = await semear(db, { nome: "ALUNO COM RETORNO", dono: OLGA, retorno: "2026-10-01", hora: "14:30" });
    const antes = await q1(db, "select data_retorno::text, hora_retorno, retorno_origem, proxima_acao, retorno_confirmado_em from public.alunos where id=$1", [a.aluno]);
    expect(antes.retorno_confirmado_em).toBeTruthy();

    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.r.previa_id, "saída da Olga");
    expect(r.retornos_preservados).toBe(1);

    const depois = await q1(db, "select data_retorno::text, hora_retorno, retorno_origem, proxima_acao, retorno_confirmado_em, responsavel_atual_email from public.alunos where id=$1", [a.aluno]);
    expect(depois.data_retorno).toBe("2026-10-01");
    expect(depois.hora_retorno).toBe("14:30");
    // retorno_origem morreria por tabela: limpar_retorno_origem apaga a origem
    // quando a data vira nula, e set_resp_aluno zera a data.
    expect(depois.retorno_origem).toBe("OPERADOR");
    expect(depois.proxima_acao).toBe(antes.proxima_acao);
    // tg_aluno_reset_retorno_confirmado apagaria isto se a devolução viesse na
    // mesma linha da data — por isso ela vem num UPDATE separado.
    expect(new Date(depois.retorno_confirmado_em).toISOString())
      .toBe(new Date(antes.retorno_confirmado_em).toISOString());
    // e agora o compromisso responde ao novo responsável
    expect(depois.responsavel_atual_email).toBe(CG);
  });

  it("reaponta a agenda do operador para o novo responsável, com a mesma hora", async () => {
    const a = await semear(db, { nome: "ALUNO AGENDA", dono: OLGA, retorno: "2026-10-01", hora: "09:15" });
    const antes = await q1(db, "select operador_email, retorno_em from public.operador_agenda where aluno_id=$1", [a.aluno]);
    expect(antes.operador_email).toBe(OLGA);

    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.r.previa_id, "saída da Olga");

    const depois = await q1(db, "select operador_email, retorno_em from public.operador_agenda where aluno_id=$1", [a.aluno]);
    expect(depois.operador_email).toBe(CG);
    // o horário não se mexe: só o dono
    expect(new Date(depois.retorno_em).toISOString()).toBe(new Date(antes.retorno_em).toISOString());

    // e não sobra NADA aberto na agenda da Olga: o compromisso não pode
    // continuar na lista de quem saiu da equipe.
    const sobrouComOlga = await qn(db,
      "select * from public.operador_agenda where operador_email=$1 and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO')",
      [OLGA]);
    expect(sobrouComOlga).toHaveLength(0);
  });

  it("depois do lote inteiro, a Olga não tem nenhum retorno nem caso", async () => {
    const a = await semear(db, { nome: "ALUNO 1", dono: OLGA, retorno: "2026-10-05", hora: "10:00" });
    const b = await semear(db, { nome: "ALUNO 2", dono: OLGA, retorno: "2026-10-06", hora: "11:00" });
    await como(db, GESTAO);
    const p = await previa([a.aluno, b.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.r.previa_id, "saída da Olga");
    expect(r.retornos_preservados).toBe(2);

    expect(await qn(db, "select * from public.casos where operador_email=$1", [OLGA])).toHaveLength(0);
    expect(await qn(db, "select * from public.alunos where responsavel_atual_email=$1", [OLGA])).toHaveLength(0);
    expect(await qn(db,
      "select * from public.operador_agenda where operador_email=$1 and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO')",
      [OLGA])).toHaveLength(0);

    // os dois compromissos continuam existindo, na agenda do novo responsável
    const agenda = await qn(db,
      "select operador_email, retorno_em::text from public.operador_agenda where operador_email=$1 order by retorno_em", [CG]);
    expect(agenda).toHaveLength(2);
    expect(agenda[0].retorno_em).toMatch(/^2026-10-05 10:00/);
    expect(agenda[1].retorno_em).toMatch(/^2026-10-06 11:00/);
  });

  it("na FILA LIVRE o compromisso fica no aluno e a agenda do antigo dono é encerrada", async () => {
    // Fila livre não tem dono: deixar a linha na agenda de quem perdeu o caso
    // seria pior do que encerrá-la. O compromisso em si não se perde.
    const a = await semear(db, { nome: "ALUNO PARA A FILA", dono: OLGA, retorno: "2026-11-11", hora: "08:00" });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "FILA_LIVRE");
    await mover(p.r.previa_id, "liberar");

    const al = await q1(db, "select data_retorno::text, hora_retorno, retorno_origem from public.alunos where id=$1", [a.aluno]);
    expect(al.data_retorno).toBe("2026-11-11");
    expect(al.hora_retorno).toBe("08:00");
    expect(al.retorno_origem).toBe("OPERADOR");

    const ag = await q1(db, "select operador_email, status from public.operador_agenda where aluno_id=$1", [a.aluno]);
    expect(ag.status).toBe("CANCELADO_LIBERACAO");
    expect(ag.operador_email).toBe(OLGA); // o histórico de quem tinha não se apaga
  });

  it("o caso também mantém a data de retorno", async () => {
    const a = await semear(db, { nome: "ALUNO CASO RETORNO", dono: OLGA, retorno: "2026-12-05" });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.r.previa_id, "x");
    const c = await q1(db, "select data_retorno::text from public.casos where id=$1", [a.caso]);
    expect(c.data_retorno).toBe("2026-12-05");
  });

  it("o acionamento anterior continua registrado", async () => {
    const a = await semear(db, { nome: "ALUNO ACIONADO", dono: OLGA });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.r.previa_id, "x");
    const al = await q1(db, "select data_ultimo_acionamento, status_acionamento from public.alunos where id=$1", [a.aluno]);
    expect(al.data_ultimo_acionamento).toBeTruthy();
    expect(al.status_acionamento).toBe("MENSAGEM ENVIADA");
  });

  it("no desfazer o retorno também volta inteiro", async () => {
    const a = await semear(db, { nome: "ALUNO VOLTA", dono: OLGA, retorno: "2026-10-20", hora: "16:00" });
    await como(db, GESTAO);
    const p = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.r.previa_id, "x");
    await db.query("select public.carteira_geral_desfazer_lote($1,'engano')", [r.lote_id]);

    const al = await q1(db, "select data_retorno::text, hora_retorno, retorno_origem, responsavel_atual_email from public.alunos where id=$1", [a.aluno]);
    expect(al.data_retorno).toBe("2026-10-20");
    expect(al.hora_retorno).toBe("16:00");
    expect(al.retorno_origem).toBe("OPERADOR");
    expect(al.responsavel_atual_email).toBe(OLGA);
    expect((await q1(db, "select operador_email e from public.operador_agenda where aluno_id=$1", [a.aluno])).e).toBe(OLGA);
  });
});

// ---------------------------------------------------------------------------
// Acordo de terceiro é trabalho de negociação de quem não está sendo
// remanejado. Não viaja embutido num lote.
// ---------------------------------------------------------------------------
describe("Carteira Geral — acordo de terceiro só por escolha explícita", () => {
  it("NÃO vai junto por padrão, e aparece como conflito individual", async () => {
    const a = await semear(db, { nome: "ALUNO TERCEIRO", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL");

    expect(r.acordos_de_terceiros).toBe(1);
    expect(r.acordos_de_terceiros_selecionados).toBe(0);
    expect(r.total_acordos).toBe(0); // nada vai

    // o conflito é POR ACORDO, com o que a gestão precisa para decidir
    const c = r.conflitos.find((x) => x.tipo === "ACORDO_DE_TERCEIRO_FICA");
    expect(c.acordo_id).toBe(a.acordo);
    expect(c.de_email).toBe(LUANA);
    expect(c.numero).toBe("777");
    expect(c.status).toBe("ATIVO");
    expect(c.detalhe).toMatch(/Selecione o acordo se quiser leva-lo/);

    await mover(r.previa_id, "x");
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(LUANA);
  });

  it("vai quando o id é escolhido, e o conflito muda de rótulo", async () => {
    const a = await semear(db, { nome: "ALUNO TERCEIRO 2", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL", { acordoIds: [a.acordo] });

    expect(r.acordos_de_terceiros_selecionados).toBe(1);
    expect(r.total_acordos).toBe(1);
    expect(r.conflitos.some((x) => x.tipo === "ACORDO_DE_TERCEIRO_SELECIONADO")).toBe(true);

    await mover(r.previa_id, "x");
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(CG);
  });

  it("escolher o acordo de um aluno não arrasta o de outro", async () => {
    const a = await semear(db, { nome: "ALUNO A", dono: OLGA, donoAcordo: LUANA });
    const b = await semear(db, { nome: "ALUNO B", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno, b.aluno], "CARTEIRA_GERAL", { acordoIds: [a.acordo] });
    expect(r.acordos_de_terceiros).toBe(2);
    expect(r.acordos_de_terceiros_selecionados).toBe(1);

    await mover(r.previa_id, "x");
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(CG);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [b.acordo])).e).toBe(LUANA);
  });

  it("acordo do PRÓPRIO dono vai junto, e avisa quando fica para trás", async () => {
    const a = await semear(db, { nome: "ALUNO PROPRIO", dono: OLGA });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL");
    expect(r.acordos_de_terceiros).toBe(0);
    expect(r.total_acordos).toBe(1);
    await mover(r.previa_id, "x");
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(CG);

    const b = await semear(db, { nome: "ALUNO PROPRIO 2", dono: OLGA });
    const { r: r2 } = await previa([b.aluno], "CARTEIRA_GERAL", { acordosDoDono: false });
    expect(r2.total_acordos).toBe(0);
    const aviso = r2.conflitos.find((x) => x.tipo === "ACORDO_DO_DONO_FICA");
    expect(aviso.detalhe).toMatch(/_aluno_segue_dono_do_acordo devolve o aluno/);
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
    await expect(previa([a.aluno], "CARTEIRA_GERAL")).rejects.toThrow(/Sem permissao/);
  });

  it("a Amanda ADM entra, mesmo com pode_alterar_responsavel = false", async () => {
    const flag = await q1(db, "select pode_alterar_responsavel f from public.usuarios where email = $1", [ADM]);
    expect(flag.f).toBe(false);
    const a = await semear(db, { nome: "ALUNO CINCO", dono: OLGA });
    await como(db, ADM);
    expect((await previa([a.aluno], "CARTEIRA_GERAL")).r.total_alunos).toBe(1);
  });

  it("sem sessão, nada", async () => {
    await como(db, null);
    await expect(db.query("select public.carteira_geral_painel('{}'::jsonb)")).rejects.toThrow();
  });
});

describe("Carteira Geral — prévia", () => {
  it("conta alunos, acordos e valor, e avisa que o retorno segue junto", async () => {
    const a = await semear(db, { nome: "ALUNO SEIS", dono: OLGA, mensalidade: 1000, parcela: 2000 });
    await como(db, GESTAO);
    const { r } = await previa([a.aluno], "CARTEIRA_GERAL");

    expect(r.total_alunos).toBe(1);
    expect(r.total_acordos).toBe(1);
    expect(Number(r.total_valor)).toBe(3000);
    expect(Number(r.total_mensalidade)).toBe(1000);
    expect(Number(r.total_acordo_valor)).toBe(2000);
    expect(r.retornos_preservados).toBe(1);

    const c = r.conflitos.find((x) => x.tipo === "RETORNO_AGENDADO_SEGUE");
    expect(c.detalhe).toMatch(/preservado e passa a responder ao novo responsavel/);
  });

  it("recusa destino inexistente e operador inativo", async () => {
    const a = await semear(db, { nome: "ALUNO NOVE", dono: OLGA });
    await como(db, GESTAO);
    await expect(previa([a.aluno], "QUALQUER")).rejects.toThrow(/Destino invalido/);
    await expect(previa([a.aluno], "OPERADOR", { email: "ninguem@aelbra.com.br" })).rejects.toThrow(/invalido ou inativo/);
  });

  it("a prévia não move nada", async () => {
    const a = await semear(db, { nome: "ALUNO DEZ", dono: OLGA });
    await como(db, GESTAO);
    await previa([a.aluno], "CARTEIRA_GERAL");
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
  });
});

describe("Carteira Geral — execução revalida o que congelou", () => {
  it("move caso, ficha e acordo, e registra a auditoria completa", async () => {
    const a = await semear(db, { nome: "ALUNO ONZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "saída da Olga");

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
    expect(aud.acordos_movidos).toBe(1);
    // o detalhe guarda o estado do acordo no momento do lote — é o que o
    // desfazer vai conferir depois
    expect(aud.acordos_detalhe[0]).toMatchObject({ de_email: OLGA, para_email: CG, status_no_lote: "ATIVO" });
  });

  it("exige motivo", async () => {
    const a = await semear(db, { nome: "ALUNO DOZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await expect(mover(p.previa_id, "   ")).rejects.toThrow(/motivo/i);
  });

  it("a mesma prévia não roda duas vezes", async () => {
    const a = await semear(db, { nome: "ALUNO TREZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "x");
    await expect(mover(p.previa_id, "x")).rejects.toThrow(/ja foi executada/);
  });

  it("recusa o aluno cujo dono mudou entre a prévia e a confirmação", async () => {
    const a = await semear(db, { nome: "ALUNO CATORZE", dono: OLGA });
    const b = await semear(db, { nome: "ALUNO QUINZE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno, b.aluno], "CARTEIRA_GERAL");

    await db.query("select internal.set_resp_aluno($1,$2,'Luana','X','y','sistema','sistema')", [a.aluno, LUANA]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(1);
    expect(r.total_recusados).toBe(1);
    expect(r.recusados[0]).toMatchObject({ nivel: "ALUNO", nome: "ALUNO CATORZE" });
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(LUANA);
  });

  // -------------------------------------------------------------------------
  // TUDO-OU-NADA POR ALUNO. Mover o caso e deixar um acordo para trás criaria
  // justamente a titularidade divergente que este PR existe para acabar.
  // -------------------------------------------------------------------------
  it("acordo com responsável mudado recusa o ALUNO INTEIRO: nada dele é tocado", async () => {
    const a = await semear(db, { nome: "ALUNO DEZESSEIS", dono: OLGA, retorno: "2026-10-09", hora: "13:00" });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");

    // alguém passou o acordo para a Luana no intervalo
    await db.query("select internal.set_resp_acordo($1,$2,'Luana','X','y','sistema','sistema')", [a.acordo, LUANA]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(0);
    expect(r.acordos_movidos).toBe(0);
    expect(r.alunos_recusados_por_acordo).toBe(1);
    expect(r.recusados[0]).toMatchObject({ nivel: "ALUNO" });
    expect(r.recusados[0].motivo).toMatch(/NADA deste aluno foi movido/);
    expect(r.recusados[0].motivo).toMatch(/responsavel do acordo .* mudou/);

    // e NADA do aluno mudou — caso, ficha, agenda e o acordo
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(OLGA);
    expect((await q1(db, "select operador_email e from public.operador_agenda where aluno_id=$1", [a.aluno])).e).toBe(OLGA);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(LUANA);
    // nem a auditoria registra o aluno recusado
    expect(await qn(db, "select * from public.carteira_geral_auditoria where aluno_id=$1", [a.aluno])).toHaveLength(0);
  });

  it("acordo com status mudado recusa o ALUNO INTEIRO", async () => {
    const a = await semear(db, { nome: "ALUNO DEZESSETE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");

    await db.query("update public.acordos set status='QUITADO' where id=$1", [a.acordo]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(0);
    expect(r.recusados[0].motivo).toMatch(/status do acordo .* mudou/);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
  });

  it("acordo que deixou de existir recusa o ALUNO INTEIRO", async () => {
    const a = await semear(db, { nome: "ALUNO SUMIU O ACORDO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");

    await db.query("delete from public.parcelas where acordo_id=$1", [a.acordo]);
    await db.query("delete from public.acordos where id=$1", [a.acordo]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(0);
    expect(r.recusados[0].motivo).toMatch(/nao existe mais/);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
  });

  it("um aluno recusado NÃO derruba o lote: os válidos seguem", async () => {
    const ruim = await semear(db, { nome: "ALUNO RUIM", dono: OLGA });
    const bom1 = await semear(db, { nome: "ALUNO BOM 1", dono: OLGA });
    const bom2 = await semear(db, { nome: "ALUNO BOM 2", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([ruim.aluno, bom1.aluno, bom2.aluno], "CARTEIRA_GERAL");

    await db.query("update public.acordos set status='CANCELADO' where id=$1", [ruim.acordo]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(2);
    expect(r.total_recusados).toBe(1);
    expect(r.acordos_movidos).toBe(2);

    // o recusado ficou inteiro onde estava
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [ruim.caso])).e).toBe(OLGA);
    // os bons foram, com acordo e tudo
    for (const b of [bom1, bom2]) {
      expect((await q1(db, "select operador_email e from public.casos where id=$1", [b.caso])).e).toBe(CG);
      expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [b.acordo])).e).toBe(CG);
    }
  });

  it("acordo de terceiro NÃO selecionado não bloqueia o aluno, mesmo se mudar", async () => {
    // Só o que a prévia marcou `mover` é revalidado. Um acordo de terceiro que
    // ficou de fora pode mudar à vontade: ele não faz parte do plano.
    const a = await semear(db, { nome: "ALUNO TERCEIRO LIVRE", dono: OLGA, donoAcordo: LUANA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    expect(p.total_acordos).toBe(0);

    await db.query("update public.acordos set status='QUITADO' where id=$1", [a.acordo]);

    const { r } = await mover(p.previa_id, "lote");
    expect(r.alunos_movidos).toBe(1);
    expect(r.total_recusados).toBe(0);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
  });
});

describe("Carteira Geral — o que não muda", () => {
  it("valores, parcelas e títulos ficam intactos", async () => {
    const a = await semear(db, { nome: "ALUNO DEZOITO", dono: OLGA, mensalidade: 1234.56, parcela: 999.99 });
    const consulta = `select
        (select round(sum(valor),2) from public.parcelas p join public.acordos ac on ac.id=p.acordo_id where ac.aluno_id=$1) parcelas,
        (select round(sum(saldo_corrigido),2) from public.acordos_titulos where aluno_id=$1) titulos,
        (select round(sum(valor_total),2) from public.acordos where aluno_id=$1) acordos`;
    const antes = await q1(db, consulta, [a.aluno]);

    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "x");

    expect(await q1(db, consulta, [a.aluno])).toEqual(antes);
  });

  it("o histórico de quem mexeu continua no lugar e ganha a nova movimentação", async () => {
    const a = await semear(db, { nome: "ALUNO DEZENOVE", dono: OLGA });
    await db.query(
      "insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,registrado_por_email) values ($1,'ACIONAMENTO','Olga negociou',$2)",
      [a.aluno, OLGA]);

    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "x");

    const movs = await qn(db, "select tipo, registrado_por_email from public.aluno_movimentacoes where aluno_id=$1 order by id", [a.aluno]);
    expect(movs[0]).toEqual({ tipo: "ACIONAMENTO", registrado_por_email: OLGA });
    expect(movs.some((m) => m.tipo === "CARTEIRA_GERAL_REMANEJAMENTO")).toBe(true);
  });

  it("a Carteira Geral não recebe notificação de acordo", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "x");
    const n = await qn(db, "select * from public.notificacoes where usuario_destino_email = $1", [CG]);
    expect(n).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Desfazer não pode atropelar quem trabalhou depois.
// ---------------------------------------------------------------------------
describe("Carteira Geral — desfazer sem sobrescrever trabalho posterior", () => {
  it("devolve caso, ficha e acordo ao dono anterior", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE E UM", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");

    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(1);
    expect(d.acordos_devolvidos).toBe(1);
    expect(d.total_recusados).toBe(0);

    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(OLGA);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(OLGA);
  });

  it("RECUSA o aluno que foi assumido da fila livre depois do lote", async () => {
    const a = await semear(db, { nome: "ALUNO ASSUMIDO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "FILA_LIVRE");
    const { r } = await mover(p.previa_id, "liberar");

    // a Luana pegou o caso na fila livre — trabalho real, posterior ao lote
    await como(db, LUANA);
    expect((await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno])).sucesso).toBe(true);

    await como(db, GESTAO);
    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(0);
    expect(d.total_recusados).toBe(1);
    expect(d.recusados[0].motivo).toMatch(/assumido ou movido de novo/);
    // e a Luana continua com o caso
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(LUANA);
  });

  it("RECUSA o aluno movido de novo pela gestão depois do lote", async () => {
    const a = await semear(db, { nome: "ALUNO REMOVIDO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");

    const { r: p2 } = await previa([a.aluno], "OPERADOR", { email: LUANA });
    await mover(p2.previa_id, "segundo lote");

    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(0);
    expect(d.total_recusados).toBe(1);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(LUANA);
  });

  it("RECUSA quando um acordo do lote mudou de status depois", async () => {
    const a = await semear(db, { nome: "ALUNO ACORDO QUITADO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");

    await db.query("update public.acordos set status='QUITADO' where id=$1", [a.acordo]);

    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(0);
    expect(d.recusados[0].motivo).toMatch(/mudou de status depois do lote/);
    // não desfez pela metade: o aluno continua onde o lote o deixou
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
  });

  it("desfaz o que está intacto e recusa só o que foi mexido", async () => {
    const a = await semear(db, { nome: "ALUNO INTACTO", dono: OLGA });
    const b = await semear(db, { nome: "ALUNO MEXIDO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno, b.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");

    await db.query("select internal.set_resp_aluno($1,$2,'Luana','X','y','sistema','sistema')", [b.aluno, LUANA]);

    const { r: d } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'engano') r", [r.lote_id]);
    expect(d.alunos_devolvidos).toBe(1);
    expect(d.total_recusados).toBe(1);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [b.caso])).e).toBe(LUANA);

    // a linha recusada NÃO fica marcada como desfeita: o lote segue meio vivo,
    // e isso tem de ser visível.
    const linhas = await qn(db, "select nome_aluno, desfeito_em from public.carteira_geral_auditoria where lote_id=$1 order by nome_aluno", [r.lote_id]);
    expect(linhas.find((l) => l.nome_aluno === "ALUNO INTACTO").desfeito_em).toBeTruthy();
    expect(linhas.find((l) => l.nome_aluno === "ALUNO MEXIDO").desfeito_em).toBeNull();
  });

  it("desfazer duas vezes não faz nada na segunda", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE E DOIS", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");
    await db.query("select public.carteira_geral_desfazer_lote($1,'engano')", [r.lote_id]);
    const { r: d2 } = await q1(db, "select public.carteira_geral_desfazer_lote($1,'de novo') r", [r.lote_id]);
    expect(d2.alunos_devolvidos).toBe(0);
  });

  it("a auditoria é append-only: não se apaga e não se reescreve", async () => {
    const a = await semear(db, { nome: "ALUNO VINTE E TRES", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    const { r } = await mover(p.previa_id, "x");

    await expect(db.query("delete from public.carteira_geral_auditoria where lote_id=$1", [r.lote_id])).rejects.toThrow(/append-only/);
    await expect(db.query("update public.carteira_geral_auditoria set motivo='outro' where lote_id=$1", [r.lote_id])).rejects.toThrow(/append-only/);
    await db.query("update public.carteira_geral_auditoria set desfeito_em=now() where lote_id=$1", [r.lote_id]);
  });
});


// ---------------------------------------------------------------------------
// Os 2 cenários medidos em produção (24/09/2026): aluno da Olga cuja dívida
// inteira é um acordo de OUTRA pessoa, sem mensalidade em aberto. Depois do
// recolhimento o acordo fica com o terceiro de propósito — e é aí que
// `_aluno_segue_dono_do_acordo` puxaria o aluno de volta.
//   . Cainã Costa Demeneghi  — acordo 3071, R$ 463,43, da Rafaella
//   . Leônidas A. de M. Melo — acordo 1271, R$ 441,73, do Allan
// ---------------------------------------------------------------------------
describe("Carteira Geral — o gatilho do acordo não desfaz a decisão da gestão", () => {
  // Reproduz o caso: sem mensalidade em aberto, todo o saldo no acordo de terceiro.
  async function cenarioDosDois(nome, terceiro) {
    // Nasce COM mensalidade: senão `_aluno_segue_dono_do_acordo` já levaria o
    // aluno para o terceiro no INSERT do acordo, e ele nem chegaria à Olga.
    // A mensalidade some depois — é assim que estes 2 casos reais ficaram.
    const a = await semear(db, { nome, dono: OLGA, mensalidade: 1000, parcela: 463.43, donoAcordo: terceiro });
    await db.query("delete from public.acordos_titulos where aluno_id=$1", [a.aluno]);
    // o caso ainda é da Olga e o acordo é do terceiro: é este o ponto de partida
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(terceiro);
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "saída da Olga");
    return a;
  }

  it("o aluno fica na Carteira Geral quando o acordo de terceiro muda de status", async () => {
    const a = await cenarioDosDois("CAINA COSTA DEMENEGHI", LUANA);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(CG);

    // a Luana reativa o acordo dela — o gatilho dispara
    await db.query("update public.acordos set status='ATIVO' where id=$1", [a.acordo]);

    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(CG);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
    // e o acordo continua com quem negociou
    expect((await q1(db, "select operador_responsavel_email e from public.acordos where id=$1", [a.acordo])).e).toBe(LUANA);
  });

  it("o aluno fica na Carteira Geral quando o acordo de terceiro troca de dono", async () => {
    const a = await cenarioDosDois("LEONIDAS ARAUJO", LUANA);
    await db.query("select internal.set_resp_acordo($1,$2,'Olga','X','y','sistema','sistema')", [a.acordo, OLGA]);

    // nem mesmo passando o acordo de volta para a Olga o aluno a segue
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(CG);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(CG);
  });

  it("sem a trava, o gatilho levaria o aluno embora — é isto que ela impede", async () => {
    // Mesmo cenário, mas o aluno NÃO está na Carteira Geral: o gatilho age
    // normalmente. Prova que a trava é específica, e não um desligamento geral.
    const a = await semear(db, { nome: "ALUNO SOLTO", dono: OLGA, mensalidade: 1000, parcela: 500, donoAcordo: LUANA });
    await db.query("delete from public.acordos_titulos where aluno_id=$1", [a.aluno]);
    await db.query("update public.acordos set status='ATIVO' where id=$1", [a.acordo]);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(LUANA);
  });

  it("o recolhimento não mexe em autoria nem em valor do acordo de terceiro", async () => {
    const a = await cenarioDosDois("CAINA VALOR", LUANA);
    const ac = await q1(db, "select status, valor_total, numero_acordo from public.acordos where id=$1", [a.acordo]);
    expect(ac.status).toBe("ATIVO");
    expect(Number(ac.valor_total)).toBe(463.43);
    expect(Number(ac.numero_acordo)).toBe(777);
    const par = await q1(db, "select round(sum(valor),2) v from public.parcelas where acordo_id=$1", [a.acordo]);
    expect(Number(par.v)).toBe(463.43);
  });
});

// ---------------------------------------------------------------------------
// A fidelização é o vazamento mais perigoso: cron diário às 08:20 que solta
// TODO caso com dono não nulo passado de 10 dias sem acionamento. A Carteira
// Geral tem dono não nulo e, por definição, ninguém a aciona.
// ---------------------------------------------------------------------------
describe("Carteira Geral — a fidelização não a esvazia", () => {
  it("o job das 08:20 solta o caso do operador e NÃO solta o da Carteira Geral", async () => {
    const naCG = await semear(db, { nome: "ALUNO NA CG", dono: OLGA });
    const doOperador = await semear(db, { nome: "ALUNO DA LUANA", dono: LUANA });
    // ambos parados há mais de 10 dias
    await db.query("update public.casos set data_ultimo_acionamento = current_date - 30");

    await como(db, GESTAO);
    const { r: p } = await previa([naCG.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "recolhimento");
    await db.query("update public.casos set data_ultimo_acionamento = current_date - 30");

    await db.query("select public.liberar_casos_fidelizacao_vencida()");

    expect((await q1(db, "select operador_email e from public.casos where id=$1", [naCG.caso])).e).toBe(CG);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [doOperador.caso])).e).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Olga saiu da equipe. O desligamento de verdade é `usuarios.ativo = false`.
// ---------------------------------------------------------------------------
describe("Carteira Geral — ex-operadora não recebe nem assume por nenhuma porta", () => {
  async function desligarDaEquipe() {
    await db.query("update public.usuarios set ativo = false where email = $1", [OLGA]);
  }

  it("hoje a guarda de operador ativo é letra morta na fila livre — a nova porta fecha isso", async () => {
    // nome_operador_por_email NUNCA devolve null (cai em upper(split_part(...))),
    // então `if v_nome is null` nunca dispara. Só a checagem nova barra.
    const morta = await q1(db, "select public.nome_operador_por_email($1) n", ["quem.saiu@aelbra.com.br"]);
    expect(morta.n).not.toBeNull();

    const a = await semear(db, { nome: "ALUNO LIVRE X", dono: null });
    await desligarDaEquipe();
    await como(db, OLGA);
    const r = await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno]);
    expect(r.sucesso).toBe(false);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBeNull();
  });

  it("não assume por caso, por aluno nem por atendimento", async () => {
    const a = await semear(db, { nome: "ALUNO LIVRE Y", dono: null });
    await desligarDaEquipe();
    await como(db, OLGA);

    expect((await q1(db, "select * from public.assumir_caso_livre($1)", [a.caso])).sucesso).toBe(false);
    expect((await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno])).sucesso).toBe(false);
    expect((await q1(db, "select public.sistema_assumir_atendimento($1) r", [a.aluno])).r.ok).toBe(false);
    expect((await q1(db, "select * from public.assumir_atendimento_aluno('x')")).sucesso).toBe(false);
  });

  it("uma ligação receptiva NÃO a autoriza a reassumir o aluno", async () => {
    const a = await semear(db, { nome: "ALUNO QUE LIGOU", dono: null });
    await desligarDaEquipe();
    await como(db, OLGA);

    const r = await q1(db, "select public.sistema_assumir_receptivo($1,'CONTATAR','atendeu',null,null) r", [a.aluno]);
    expect(r.r.ok).toBe(false);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBeNull();
    expect((await q1(db, "select operador_email e from public.alunos where id=$1", [a.aluno])).e).toBeNull();
  });

  it("nem entra no rodízio do receptivo, então a ligação não é roteada para ela", async () => {
    await desligarDaEquipe();
    await db.query("select public.fila_receptivo_heartbeat($1,'Olga',false)", [OLGA]);
    expect(await qn(db, "select * from public.fila_receptivo where operador_email=$1", [OLGA])).toHaveLength(0);

    // operadora ativa continua entrando normalmente
    await db.query("select public.fila_receptivo_heartbeat($1,'Luana',false)", [LUANA]);
    expect(await qn(db, "select * from public.fila_receptivo where operador_email=$1", [LUANA])).toHaveLength(1);
  });

  it("a gestão também não consegue mais atribuir para ela pelo caminho oficial", async () => {
    await desligarDaEquipe();
    await como(db, GESTAO);
    const a = await semear(db, { nome: "ALUNO PARA A OLGA", dono: null });
    await expect(previa([a.aluno], "OPERADOR", { email: OLGA })).rejects.toThrow(/invalido ou inativo/);
  });

  it("operadora ATIVA continua atendendo pelo receptivo — o fluxo legítimo não quebra", async () => {
    const a = await semear(db, { nome: "ALUNO DO RECEPTIVO", dono: null });
    await como(db, LUANA);
    const r = await q1(db, "select public.sistema_assumir_receptivo($1,'CONTATAR','atendeu',null,null) r", [a.aluno]);
    expect(r.r.ok).toBe(true);
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(LUANA);
  });

  it("nem a operadora ativa tira aluno da Carteira Geral por telefone", async () => {
    const a = await semear(db, { nome: "ALUNO NA CG RECEPTIVO", dono: OLGA });
    await como(db, GESTAO);
    const { r: p } = await previa([a.aluno], "CARTEIRA_GERAL");
    await mover(p.previa_id, "recolhimento");

    await como(db, LUANA);
    const r = await q1(db, "select public.sistema_assumir_receptivo($1,'CONTATAR','atendeu',null,null) r", [a.aluno]);
    expect(r.r.erro).toBe("NA_CARTEIRA_GERAL");
    expect((await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [a.aluno])).e).toBe(CG);
  });
});

// ---------------------------------------------------------------------------
// Desligar alguém tem de fechar as DUAS portas.
// ---------------------------------------------------------------------------
describe("Carteira Geral — operador fora da entrada de casos novos", () => {
  async function desligar(email) {
    await como(db, GESTAO);
    await db.query("select public.carteira_geral_definir_recebimento($1, false, 'saída da Olga')", [email]);
  }

  it("a gestão desliga e liga, com registro na auditoria", async () => {
    await desligar(OLGA);
    expect((await q1(db, "select recebe_novos_casos d from public.usuarios where email=$1", [OLGA])).d).toBe(false);

    const log = await q1(db, "select detalhes from public.auditoria where acao='CARTEIRA_GERAL_RECEBIMENTO'");
    expect(log.detalhes.operador).toBe("Olga");
    expect(log.detalhes.motivo).toBe("saída da Olga");

    await db.query("select public.carteira_geral_definir_recebimento($1, true, 'voltou')", [OLGA]);
    expect((await q1(db, "select recebe_novos_casos d from public.usuarios where email=$1", [OLGA])).d).toBe(true);
  });

  it("desligada, NÃO assume da fila livre", async () => {
    const a = await semear(db, { nome: "ALUNO LIVRE", dono: null });
    await desligar(OLGA);

    await como(db, OLGA);
    const r = await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno]);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toMatch(/carteira esta fechada para casos novos/);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBeNull();
  });

  it("desligada, NÃO assume pelo caso e nem pelo atendimento", async () => {
    const a = await semear(db, { nome: "ALUNO LIVRE 2", dono: null });
    await desligar(OLGA);
    await como(db, OLGA);

    expect((await q1(db, "select * from public.assumir_caso_livre($1)", [a.caso])).mensagem)
      .toMatch(/carteira esta fechada/);
    expect((await q1(db, "select public.sistema_assumir_atendimento($1) r", [a.aluno])).r.erro)
      .toBe("CARTEIRA_FECHADA_PARA_NOVOS");
    expect((await q1(db, "select * from public.assumir_atendimento_aluno('x')")).mensagem)
      .toMatch(/carteira esta fechada/);
  });

  it("desligada, sai da distribuição automática e da simulação da calibragem", async () => {
    await desligar(OLGA);
    // a rotina das 09:20 e a calibragem da tela passam a não enxergá-la
    expect((await q1(db, "select public.nivelamento_automatico_gestao(10,false) r")).r.destinos).toBe(1); // só a Luana
    expect((await q1(db, "select public.calibragem_simular_nivelamento_impl('{}'::jsonb) r")).r.operadores).toBe(1);
  });

  it("desligada, a reposição automática a pula e diz por quê", async () => {
    await desligar(OLGA);
    await db.query("insert into public.reposicao_carteira_fila (operador_email, tipo) values ($1,'QUITADO')", [OLGA]);
    await db.query("select public.reposicao_carteira_processar(5)");
    const f = await q1(db, "select erro, repostos from public.reposicao_carteira_fila where operador_email=$1", [OLGA]);
    expect(f.repostos).toBe(0);
    expect(f.erro).toMatch(/fora da entrada de casos novos/);
  });

  it("LIGADA, continua assumindo normalmente", async () => {
    const a = await semear(db, { nome: "ALUNO LIVRE 3", dono: null });
    await como(db, OLGA);
    expect((await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno])).sucesso).toBe(true);
  });

  it("desligar não tira o que já é dela", async () => {
    const a = await semear(db, { nome: "ALUNO DELA", dono: OLGA });
    await desligar(OLGA);
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBe(OLGA);
  });

  it("operador não mexe nisso", async () => {
    await como(db, OLGA);
    await expect(db.query("select public.carteira_geral_definir_recebimento($1,false,'x')", [OLGA])).rejects.toThrow(/Sem permissao/);
  });
});

// ---------------------------------------------------------------------------
// PERMISSÃO — o que o preflight de 25/09/2026 pegou em produção.
//
// `public.fila_receptivo_heartbeat` é a ÚNICA das 14 funções patcheadas que é
// SECURITY INVOKER: ela roda como o operador logado, e `authenticated` NÃO tem
// USAGE no schema `internal`. A primeira versão do patch a fazia chamar
// `internal.operador_pode_receber_caso` direto — o que derrubaria o heartbeat de
// todo operador ativo com `42501 permission denied for schema internal`.
//
// Os testes de comportamento não pegaram isso porque o vitest roda como dono do
// banco, que ignora ACL. Estes rodam `set role authenticated`.
// ---------------------------------------------------------------------------
describe("Carteira Geral — permissão: heartbeat como authenticated, internal fechado", () => {
  let db;
  beforeEach(async () => { db = await montar(); });

  it("o schema internal continua fechado para authenticated", async () => {
    const p = await q1(db, `select
      has_schema_privilege('authenticated','internal','USAGE') usa_internal,
      has_schema_privilege('anon','internal','USAGE')          anon_usa_internal`);
    expect(p.usa_internal).toBe(false);
    expect(p.anon_usa_internal).toBe(false);
  });

  it("chamar internal.operador_pode_receber_caso como authenticated é recusado", async () => {
    await comoPapel(db, LUANA);
    try {
      await expect(
        db.query("select internal.operador_pode_receber_caso($1)", [LUANA])
      ).rejects.toThrow(/permission denied for schema internal/i);
    } finally {
      await voltarDono(db);
    }
  });

  it("o invólucro em public é a porta: responde para authenticated", async () => {
    await comoPapel(db, LUANA);
    try {
      const r = await q1(db, "select public.operador_pode_receber_caso($1) pode", [LUANA]);
      expect(r.pode).toBe(true);
    } finally {
      await voltarDono(db);
    }
  });

  it("o invólucro tem permissão mínima: authenticated e service_role, nunca anon nem public", async () => {
    const p = await q1(db, `select
      has_function_privilege('authenticated','public.operador_pode_receber_caso(text)','EXECUTE') auth,
      has_function_privilege('service_role','public.operador_pode_receber_caso(text)','EXECUTE')  svc,
      has_function_privilege('anon','public.operador_pode_receber_caso(text)','EXECUTE')          anon,
      (select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='operador_pode_receber_caso')                      definer`);
    expect(p.auth).toBe(true);
    expect(p.svc).toBe(true);
    expect(p.anon).toBe(false);
    expect(p.definer).toBe(true);
  });

  it("o heartbeat patcheado NÃO cita o schema internal — é o que quebraria em produção", async () => {
    const d = await q1(db, `select pg_get_functiondef(p.oid) def
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='fila_receptivo_heartbeat'`);
    expect(d.def).toContain("public.operador_pode_receber_caso(p_email)");
    expect(d.def).not.toContain("internal.");
  });

  it("OPERADORA ATIVA: o heartbeat funciona rodando como authenticated", async () => {
    await comoPapel(db, LUANA);
    try {
      await db.query("select public.fila_receptivo_heartbeat($1,'Luana',false)", [LUANA]);
    } finally {
      await voltarDono(db);
    }
    expect(await qn(db, "select * from public.fila_receptivo where operador_email=$1", [LUANA]))
      .toHaveLength(1);
  });

  it("EX-OPERADORA: como authenticated, o heartbeat passa sem erro e sem entrar na fila", async () => {
    await db.query("update public.usuarios set ativo = false where email = $1", [OLGA]);
    await comoPapel(db, OLGA);
    try {
      // não lança: a guarda devolve em silêncio, que é o desenho -- a tela dela
      // não pode explodir por causa do desligamento.
      await db.query("select public.fila_receptivo_heartbeat($1,'Olga',false)", [OLGA]);
    } finally {
      await voltarDono(db);
    }
    expect(await qn(db, "select * from public.fila_receptivo where operador_email=$1", [OLGA]))
      .toHaveLength(0);
  });

  it("EX-OPERADORA como authenticated também não assume por nenhuma porta", async () => {
    const a = await semear(db, { nome: "ALUNO LIVRE ACL", dono: null });
    await db.query("update public.usuarios set ativo = false where email = $1", [OLGA]);
    await comoPapel(db, OLGA);
    try {
      expect((await q1(db, "select * from public.assumir_caso_livre($1)", [a.caso])).sucesso).toBe(false);
      expect((await q1(db, "select * from public.assumir_caso_livre_aluno($1)", [a.aluno])).sucesso).toBe(false);
      expect((await q1(db, "select public.sistema_assumir_atendimento($1) r", [a.aluno])).r.ok).toBe(false);
      expect((await q1(db, "select public.sistema_assumir_receptivo($1,'CONTATAR','x',null,null) r", [a.aluno])).r.ok).toBe(false);
    } finally {
      await voltarDono(db);
    }
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [a.caso])).e).toBeNull();
  });

  it("recebe_novos_casos=false barra o heartbeat mesmo com a operadora ATIVA", async () => {
    await db.query("update public.usuarios set recebe_novos_casos = false where email = $1", [LUANA]);
    await comoPapel(db, LUANA);
    try {
      await db.query("select public.fila_receptivo_heartbeat($1,'Luana',false)", [LUANA]);
    } finally {
      await voltarDono(db);
    }
    expect(await qn(db, "select * from public.fila_receptivo where operador_email=$1", [LUANA]))
      .toHaveLength(0);
    expect((await q1(db, "select ativo a from public.usuarios where email=$1", [LUANA])).a).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Portão de gestão no carteira_geral_vigia — migration 20260926143256,
// APLICADA em produção em 26/09/2026 às 14:32:56 UTC.
//
// O teste lê a própria migration pelo caminho do repositório: se ela mudar,
// estes casos acusam.
//
// Antes dela, o vigia era SECURITY DEFINER com grant para `authenticated` e SEM
// portão: qualquer operador logado lia a lista de quem a gestão desligou. Os
// casos abaixo aplicam a migration sobre a bancada e provam os dois lados.
// ---------------------------------------------------------------------------
const AQUI_T = dirname(fileURLToPath(import.meta.url));
const TRAVA_VIGIA = readFileSync(
  resolve(AQUI_T, "..", "migrations", "20260926143256_trava_vigia_carteira_geral.sql"),
  "utf8",
);

describe("Carteira Geral — portão de gestão no vigia (20260926143256)", () => {
  let db;
  const NAO_GESTAO = "cobranca99@aelbra.com.br";

  // Dados não triviais, para "idêntico" significar alguma coisa.
  async function cenario() {
    const a = await semear(db, { nome: "ALUNA NA CG", dono: CG });
    await db.query("update public.acordos set operador_responsavel_email=$1 where aluno_id=$2", [CG, a.aluno]);
    await db.query("update public.usuarios set ativo=false where email=$1", [OLGA]);
    return a;
  }

  beforeEach(async () => {
    db = await montar();
    await db.query(
      "insert into public.usuarios (nome,email,perfil,ativo) values ('Quem',$1,'operador',true)",
      [NAO_GESTAO],
    );
  });

  it("ANTES da trava: operador comum lê o vigia — é o buraco que ela fecha", async () => {
    await cenario();
    await como(db, LUANA);
    const r = await q1(db, "select public.carteira_geral_vigia() v");
    expect(r.v.na_carteira_geral).toBe(1);
    expect(r.v.operadores_sem_entrada_de_casos).toContain("Olga");
  });

  it("a saída para a gestão é IDÊNTICA antes e depois da trava", async () => {
    await cenario();
    await como(db, GESTAO);
    const antes = await q1(db, "select public.carteira_geral_vigia()::text t");
    await db.exec(TRAVA_VIGIA);
    const depois = await q1(db, "select public.carteira_geral_vigia()::text t");
    expect(depois.t).toBe(antes.t);
    // e o conteúdo não é trivial, senão a igualdade não provaria nada
    const v = (await q1(db, "select public.carteira_geral_vigia() v")).v;
    expect(v.na_carteira_geral).toBe(1);
    expect(v.acordos_na_carteira_geral).toBe(1);
    expect(v.operadores_sem_entrada_de_casos).toContain("Olga");
  });

  it("Amanda (gestão) continua autorizada", async () => {
    await cenario();
    await db.exec(TRAVA_VIGIA);
    await como(db, GESTAO);
    const v = (await q1(db, "select public.carteira_geral_vigia() v")).v;
    expect(v.na_carteira_geral).toBe(1);
    expect(v.operadores_sem_entrada_de_casos).toContain("Olga");
  });

  it("Fernanda continua autorizada, com a MESMA saída de antes", async () => {
    await cenario();
    await como(db, FERNANDA);
    const antes = await q1(db, "select public.carteira_geral_vigia()::text t");
    await db.exec(TRAVA_VIGIA);
    const depois = await q1(db, "select public.carteira_geral_vigia()::text t");
    expect(depois.t).toBe(antes.t);
    expect((await q1(db, "select public.carteira_geral_vigia() v")).v.na_carteira_geral).toBe(1);
  });

  it("Amanda ADM continua autorizada, com a MESMA saída de antes", async () => {
    await cenario();
    await como(db, ADM);
    const antes = await q1(db, "select public.carteira_geral_vigia()::text t");
    await db.exec(TRAVA_VIGIA);
    const depois = await q1(db, "select public.carteira_geral_vigia()::text t");
    expect(depois.t).toBe(antes.t);
    expect((await q1(db, "select public.carteira_geral_vigia() v")).v.na_carteira_geral).toBe(1);
  });

  // Não basta a mensagem: o código 42501 é o que a tela e o PostgREST leem.
  async function recusaCom42501(email) {
    await como(db, email);
    let erro = null;
    try { await db.query("select public.carteira_geral_vigia()"); } catch (e) { erro = e; }
    expect(erro).not.toBeNull();
    expect(String(erro.message)).toMatch(/Sem permissao para ver o vigia da Carteira Geral/);
    expect(erro.code).toBe("42501");
  }

  it("Luana (operadora ativa) é recusada com 42501", async () => {
    await db.exec(TRAVA_VIGIA);
    await recusaCom42501(LUANA);
  });

  it("Olga é recusada", async () => {
    await db.exec(TRAVA_VIGIA);
    await recusaCom42501(OLGA);
  });

  it("authenticated sem gestão é recusado", async () => {
    await db.exec(TRAVA_VIGIA);
    await recusaCom42501(NAO_GESTAO);
  });

  it("sem JWT nenhum é recusado", async () => {
    await db.exec(TRAVA_VIGIA);
    await recusaCom42501(null);
  });

  const md5Vigia = async () => (await q1(db, `select md5(p.prosrc) m from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='carteira_geral_vigia'`)).m;

  it("a precondição RECUSA aplicar se o corpo do vigia tiver mudado — e não sobrescreve", async () => {
    await db.query(`create or replace function public.carteira_geral_vigia()
      returns jsonb language sql stable security definer set search_path to 'public','internal'
      as $x$ select jsonb_build_object('na_carteira_geral', 0) $x$;`);
    const antes = await md5Vigia();
    await expect(db.exec(TRAVA_VIGIA)).rejects.toThrow(/nao e nenhum dos dois/);
    expect(await md5Vigia()).toBe(antes); // o corpo de terceiro continua intacto
  });

  // A falha que a primeira versão desta proposta tinha: ela aceitava QUALQUER
  // corpo que contivesse a palavra `calibragem_e_gestao`, até num comentário, e
  // o `create or replace` o sobrescrevia em silêncio. Agora só md5 exato passa.
  it("corpo de terceiro que apenas MENCIONA calibragem_e_gestao também é recusado", async () => {
    await db.query(`create or replace function public.carteira_geral_vigia()
      returns jsonb language sql stable security definer set search_path to 'public','internal'
      as $x$ select jsonb_build_object('outra_coisa', 1) -- calibragem_e_gestao
      $x$;`);
    const antes = await md5Vigia();
    await expect(db.exec(TRAVA_VIGIA)).rejects.toThrow(/nao e nenhum dos dois/);
    expect(await md5Vigia()).toBe(antes);
  });

  it("a trava é idempotente: rodar de novo não quebra nem muda a saída", async () => {
    await cenario();
    await db.exec(TRAVA_VIGIA);
    await como(db, GESTAO);
    const uma = await q1(db, "select public.carteira_geral_vigia()::text t");
    await db.exec(TRAVA_VIGIA);
    const duas = await q1(db, "select public.carteira_geral_vigia()::text t");
    expect(duas.t).toBe(uma.t);
  });

  it("o grant para authenticated é PRESERVADO — portão interno, nunca revoke", async () => {
    await db.exec(TRAVA_VIGIA);
    const p = await q1(db, `select
      has_function_privilege('authenticated','public.carteira_geral_vigia()','EXECUTE') auth,
      has_function_privilege('anon','public.carteira_geral_vigia()','EXECUTE') anon,
      (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='carteira_geral_vigia') definer,
      (select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='carteira_geral_vigia') volatilidade`);
    expect(p.auth).toBe(true);
    expect(p.anon).toBe(false);
    expect(p.definer).toBe(true);
    expect(p.volatilidade).toBe("s"); // continua STABLE
  });
});
