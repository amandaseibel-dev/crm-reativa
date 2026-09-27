// Acordos por RESPONSAVEL DO ACORDO — visao e remanejamento.
//
// A Carteira Geral sempre respondeu "de quem e o CASO". Medido em producao em
// 27/09/2026 para amanda.seibel@aelbra.com.br: 11 casos na tela contra 753
// acordos sob a responsabilidade dela, dos quais 726 em casos de OUTRAS
// pessoas. Estes testes fixam a separacao das duas titularidades e a garantia
// de que mover o acordo NAO arrasta o caso nem a ficha.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  montar, semear, como, q1, qn, GESTAO, FERNANDA, OLGA, LUANA, CG,
} from "./fixtures/carteira_geral/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => { db = await montar(); });
afterEach(async () => { await db?.close(); db = null; });

const painel = async (f = {}) =>
  (await q1(db, "select public.carteira_geral_acordos_painel($1::jsonb) p", [JSON.stringify(f)])).p;
const listar = async (f = {}, limite = 200, offset = 0) =>
  (await q1(db, "select public.carteira_geral_acordos_listar($1::jsonb,$2,$3) l",
            [JSON.stringify(f), limite, offset])).l;
const previa = async (ids, destino, f = {}) =>
  (await q1(db, "select public.carteira_geral_acordos_previa($1::uuid[],$2,$3::jsonb) r",
            [ids, destino, JSON.stringify(f)])).r;
const mover = async (id, motivo = "teste") =>
  (await q1(db, "select public.carteira_geral_acordos_mover($1,$2) r", [id, motivo])).r;
const desfazer = async (lote, motivo = "engano") =>
  (await q1(db, "select public.carteira_geral_acordos_desfazer_lote($1,$2) r", [lote, motivo])).r;

const acordo = async (id) =>
  q1(db, `select lower(coalesce(operador_responsavel_email,'')) email, operador_responsavel_nome nome,
                 upper(coalesce(status,'')) status, valor_total,
                 criado_por_email, criado_por_nome, confirmado_por_email, confirmado_em,
                 honorarios_percentual, honorarios_valor, criado_em
            from public.acordos where id=$1`, [id]);
const donoCaso = async (aluno) =>
  (await q1(db, `select lower(coalesce(operador_email,'')) e from public.casos
                  where aluno_id=$1 order by coalesce(encerrado_operacional,false), id limit 1`, [aluno])).e;
const donoFicha = async (aluno) =>
  (await q1(db, "select responsavel_atual_email e from public.alunos where id=$1", [aluno])).e;

describe("Acordos por responsavel — a visao nao confunde as duas titularidades", () => {
  beforeEach(async () => {
    // o caso e da OLGA, o acordo e da GESTAO: o padrao dos 726
    await semear(db, { nome: "ALUNA CASO OLGA ACORDO MEU", dono: OLGA, donoAcordo: GESTAO });
    // caso de outro operador, acordo da OLGA: o outro padrao que ela pediu
    await semear(db, { nome: "ALUNA CASO LUANA ACORDO OLGA", dono: LUANA, donoAcordo: OLGA });
    await semear(db, { nome: "ALUNA CASO LUANA ACORDO OLGA 2", dono: LUANA, donoAcordo: OLGA });
    // caso e acordo da gestao
    await semear(db, { nome: "ALUNA TUDO MEU", dono: GESTAO, donoAcordo: GESTAO });
    await como(db, GESTAO);
  });

  it("'Meus acordos' e o padrao quando nao se passa responsavel", async () => {
    const p = await painel({});
    expect(p.responsavel).toBe(GESTAO);
    expect(p.total_acordos).toBe(2);    // um no caso da Olga, um no caso dela
  });

  it("separa o acordo que esta em caso de outra pessoa", async () => {
    const p = await painel({});
    expect(p.em_caso_de_outro).toBe(1);
    const classes = Object.fromEntries(p.por_dono_do_caso.map((x) => [x.classe, x.acordos]));
    expect(classes.EU).toBe(1);
    expect(classes.OUTRO).toBe(1);
  });

  it("acordos da OLGA em casos de outros operadores aparecem para ela", async () => {
    const p = await painel({ responsavel: OLGA });
    expect(p.total_acordos).toBe(2);
    expect(p.em_caso_de_outro).toBe(2);   // ambos em caso da Luana
    const classes = Object.fromEntries(p.por_dono_do_caso.map((x) => [x.classe, x.acordos]));
    expect(classes.OUTRO).toBe(2);
    expect(classes.EU ?? 0).toBe(0);
  });

  it("a contagem de ACORDO nao e a contagem de CASO", async () => {
    const pAcordos = await painel({ responsavel: OLGA });
    const pCasos = (await q1(db, "select public.carteira_geral_painel($1::jsonb) p",
                             [JSON.stringify({ responsavel: OLGA })])).p;
    // A Olga tem 1 CASO e 2 ACORDOS, e nenhum dos dois acordos esta no caso
    // dela -- os dois estao em casos da Luana. E exatamente a forma do
    // problema real: as duas contagens nao se explicam uma pela outra.
    expect(pCasos.total_alunos).toBe(1);
    expect(pAcordos.total_acordos).toBe(2);
    expect(pAcordos.em_caso_de_outro).toBe(2);
  });

  it("a lista traz aluno, numero, status, valor e o dono do CASO", async () => {
    const l = await listar({ responsavel: OLGA });
    expect(l).toHaveLength(2);
    for (const r of l) {
      expect(r.nome).toMatch(/ALUNA CASO LUANA/);
      expect(r.numero_acordo).toBeTruthy();
      expect(r.status).toBe("ATIVO");
      expect(Number(r.valor)).toBeGreaterThan(0);
      expect(r.caso_dono_email).toBe(LUANA);
      expect(r.caso_dono_classe).toBe("OUTRO");
    }
  });

  it("o padrao da lista e ATIVO, e 'TODOS' traz o resto", async () => {
    const s = await semear(db, { nome: "QUITADO DA GESTAO", dono: GESTAO, donoAcordo: GESTAO });
    await db.query("update public.acordos set status='QUITADO' where id=$1", [s.acordo]);

    expect((await listar({})).length).toBe(2);                 // so ATIVO
    expect((await listar({ status: "TODOS" })).length).toBe(3); // com o QUITADO
    expect((await listar({ status: "QUITADO" })).length).toBe(1);
  });

  it("filtra pela classe do dono do caso e pela busca", async () => {
    expect((await listar({ responsavel: OLGA, classe_caso: "OUTRO" })).length).toBe(2);
    expect((await listar({ responsavel: OLGA, classe_caso: "EU" })).length).toBe(0);
    expect((await listar({ responsavel: OLGA, busca: "OLGA 2" })).length).toBe(1);
  });

  it("pagina", async () => {
    expect((await listar({ responsavel: OLGA }, 1, 0)).length).toBe(1);
    expect((await listar({ responsavel: OLGA }, 1, 1)).length).toBe(1);
    expect((await listar({ responsavel: OLGA }, 1, 2)).length).toBe(0);
  });

  it("quem nao e gestao nao ve nada disso", async () => {
    await como(db, LUANA);
    await expect(painel({})).rejects.toThrow(/Sem permissao/);
    await expect(listar({})).rejects.toThrow(/Sem permissao/);
  });
});

describe("Remanejamento de ACORDO — o caso e a ficha nao vao junto", () => {
  let s;

  beforeEach(async () => {
    // acordo da GESTAO num caso da OLGA
    s = await semear(db, { nome: "ACORDO MEU CASO DA OLGA", dono: OLGA, donoAcordo: GESTAO });
    await db.query(
      `update public.acordos set criado_por_email=$2, criado_por_nome='Quem Criou',
              confirmado_por_email=$2, confirmado_em=now(),
              honorarios_percentual=12.5, honorarios_valor=250.00
         where id=$1`, [s.acordo, FERNANDA]);
    await como(db, GESTAO);
  });

  it("a previa diz, acordo a acordo, que o caso fica com outra pessoa", async () => {
    const p = await previa([s.acordo], LUANA);
    expect(p.total_acordos).toBe(1);
    expect(p.total_em_caso_de_outro).toBe(1);
    const c = p.conflitos.find((x) => x.tipo === "CASO_FICA_COM_OUTRO");
    expect(c).toBeTruthy();
    expect(c.detalhe).toMatch(/o CASO e a FICHA/);
    expect(c.detalhe).toMatch(new RegExp(OLGA));
  });

  it("move o acordo e NAO move caso nem ficha", async () => {
    const casoAntes = await donoCaso(s.aluno);
    const fichaAntes = await donoFicha(s.aluno);

    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "acordo segue a operadora");

    expect(m.acordos_movidos).toBe(1);
    expect(m.total_recusados).toBe(0);
    expect(m.casos_movidos).toBe(0);
    expect(m.fichas_movidas).toBe(0);

    expect((await acordo(s.acordo)).email).toBe(LUANA);
    expect(await donoCaso(s.aluno)).toBe(casoAntes);
    expect(await donoFicha(s.aluno)).toBe(fichaAntes);
  });

  it("preserva parcelas, status, valor, honorarios e autoria historica", async () => {
    const antes = await acordo(s.acordo);
    const parcelasAntes = await qn(db, "select id, valor, vencimento, status from public.parcelas where acordo_id=$1 order by id", [s.acordo]);

    const p = await previa([s.acordo], LUANA);
    await mover(p.previa_id, "so o responsavel");

    const depois = await acordo(s.acordo);
    expect(depois.status).toBe(antes.status);
    expect(Number(depois.valor_total)).toBe(Number(antes.valor_total));
    expect(depois.criado_por_email).toBe(antes.criado_por_email);
    expect(depois.criado_por_nome).toBe(antes.criado_por_nome);
    expect(depois.confirmado_por_email).toBe(antes.confirmado_por_email);
    expect(String(depois.confirmado_em)).toBe(String(antes.confirmado_em));
    expect(Number(depois.honorarios_percentual)).toBe(12.5);
    expect(Number(depois.honorarios_valor)).toBe(250);
    expect(String(depois.criado_em)).toBe(String(antes.criado_em));

    const parcelasDepois = await qn(db, "select id, valor, vencimento, status from public.parcelas where acordo_id=$1 order by id", [s.acordo]);
    expect(parcelasDepois).toEqual(parcelasAntes);
  });

  it("grava UMA LINHA DE AUDITORIA POR ACORDO, com o que ficou para tras", async () => {
    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "motivo registrado");

    const a = await qn(db, "select * from public.carteira_geral_acordo_auditoria where lote_id=$1", [m.lote_id]);
    expect(a).toHaveLength(1);
    expect(a[0].acordo_id).toBe(s.acordo);
    expect(a[0].de_email).toBe(GESTAO);
    expect(a[0].para_email).toBe(LUANA);
    expect(a[0].motivo).toBe("motivo registrado");
    // a fotografia do que NAO se moveu
    expect(a[0].caso_dono_email).toBe(OLGA);
    expect(a[0].aluno_resp_email).toBe(OLGA);
  });

  it("recusa o acordo cujo responsavel mudou depois da previa", async () => {
    const p = await previa([s.acordo], LUANA);
    await db.query("update public.acordos set operador_responsavel_email=$2 where id=$1", [s.acordo, FERNANDA]);

    const m = await mover(p.previa_id, "tentativa");
    expect(m.acordos_movidos).toBe(0);
    expect(m.total_recusados).toBe(1);
    expect(m.recusados[0].motivo).toMatch(/responsavel mudou/);
    expect((await acordo(s.acordo)).email).toBe(FERNANDA);
  });

  it("recusa o acordo cujo status mudou depois da previa", async () => {
    const p = await previa([s.acordo], LUANA);
    await db.query("update public.acordos set status='QUITADO' where id=$1", [s.acordo]);

    const m = await mover(p.previa_id, "tentativa");
    expect(m.acordos_movidos).toBe(0);
    expect(m.total_recusados).toBe(1);
    expect(m.recusados[0].motivo).toMatch(/status mudou/);
  });

  it("desfazer devolve o acordo ao dono anterior", async () => {
    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "ida");
    expect((await acordo(s.acordo)).email).toBe(LUANA);

    const d = await desfazer(m.lote_id);
    expect(d.acordos_devolvidos).toBe(1);
    expect(d.total_recusados).toBe(0);
    expect((await acordo(s.acordo)).email).toBe(GESTAO);
    // e o caso continua onde sempre esteve
    expect(await donoCaso(s.aluno)).toBe(OLGA);
  });

  it("desfazer RECUSA o acordo que mudou depois do lote", async () => {
    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "ida");
    await db.query("update public.acordos set operador_responsavel_email=$2 where id=$1", [s.acordo, FERNANDA]);

    const d = await desfazer(m.lote_id);
    expect(d.acordos_devolvidos).toBe(0);
    expect(d.total_recusados).toBe(1);
    expect(d.recusados[0].motivo).toMatch(/responsavel mudou depois do lote/);
    expect((await acordo(s.acordo)).email).toBe(FERNANDA);   // o trabalho de outro nao foi apagado
  });

  it("a previa recusa destino inativo, e so a gestao move", async () => {
    await db.query("update public.usuarios set ativo=false where email=$1", [LUANA]);
    await expect(previa([s.acordo], LUANA)).rejects.toThrow(/inativo/);

    await db.query("update public.usuarios set ativo=true where email=$1", [LUANA]);
    const p = await previa([s.acordo], LUANA);
    await como(db, LUANA);
    await expect(mover(p.previa_id, "x")).rejects.toThrow(/Sem permissao/);
  });
});

// ---------------------------------------------------------------------------
// O perigo real: trg_aluno_segue_dono_do_acordo e AFTER UPDATE OF
// operador_responsavel_email ON acordos. Com acordo ATIVO, destino operador
// ativo e aluno SEM mensalidade em aberto, mexer no responsavel do acordo
// arrasta a ficha -- e o caso atras dela.
// ---------------------------------------------------------------------------
describe("Remanejamento de ACORDO — o portao contra o gatilho", () => {
  let s;

  // mesmo cenario dos 136: nasce COM mensalidade (o gatilho sai pela porta do
  // saldo) e ela e liquidada depois, sem tocar no acordo.
  const cenarioPerigoso = async (nome) => {
    const x = await semear(db, { nome, dono: OLGA, donoAcordo: GESTAO, statusAcordo: "ATIVO", mensalidade: 1000 });
    await db.query(
      "update public.acordos_titulos set situacao='LIQUIDADO', status='pago' where aluno_id=$1 and acordo_id is null",
      [x.aluno]);
    expect(await donoCaso(x.aluno)).toBe(OLGA);
    expect(await donoFicha(x.aluno)).toBe(OLGA);
    return x;
  };

  beforeEach(async () => { s = await cenarioPerigoso("PERIGO"); await como(db, GESTAO); });

  it("CONTROLE: mexer no acordo FORA da RPC arrasta a ficha (o gatilho esta vivo)", async () => {
    await db.query("update public.acordos set operador_responsavel_email=$2 where id=$1", [s.acordo, LUANA]);
    expect(await donoFicha(s.aluno)).toBe(LUANA);
  });

  it("pela RPC, o acordo se move e a ficha e o caso FICAM com a Olga", async () => {
    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "so o acordo");

    expect(m.acordos_movidos).toBe(1);
    expect((await acordo(s.acordo)).email).toBe(LUANA);
    expect(await donoFicha(s.aluno)).toBe(OLGA);
    expect(await donoCaso(s.aluno)).toBe(OLGA);
  });

  it("o portao e transacional: depois da RPC o gatilho volta a valer", async () => {
    const p = await previa([s.acordo], LUANA);
    await mover(p.previa_id, "so o acordo");
    expect(await donoFicha(s.aluno)).toBe(OLGA);

    // outro acordo, mexido fora da RPC: tem de arrastar de novo
    const outro = await cenarioPerigoso("PERIGO 2");
    await db.query("update public.acordos set operador_responsavel_email=$2 where id=$1", [outro.acordo, LUANA]);
    expect(await donoFicha(outro.aluno)).toBe(LUANA);
  });

  it("desfazer tambem nao arrasta a ficha de volta", async () => {
    const p = await previa([s.acordo], LUANA);
    const m = await mover(p.previa_id, "ida");
    const d = await desfazer(m.lote_id);

    expect(d.acordos_devolvidos).toBe(1);
    expect((await acordo(s.acordo)).email).toBe(GESTAO);
    expect(await donoFicha(s.aluno)).toBe(OLGA);
    expect(await donoCaso(s.aluno)).toBe(OLGA);
  });
});
