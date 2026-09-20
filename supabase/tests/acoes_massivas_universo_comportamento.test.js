// ACOES MASSIVAS: FONTE UNICA (universo), COBERTURA, DISPONIBILIDADE, PREVIA E DRILL-DOWN.
//
// PostgreSQL real (PGlite): estado de producao de 20/09/2026 + migrations
// 20260920100000/110000/120000. Carteira 100% inventada.
//
// O que este arquivo prova:
//   * RECONCILIACAO: acionados + sem acionamento = base; disponiveis + soma dos
//     motivos = sem acionamento; count do drill-down = indicador; TOTAL por aluno
//     unico (nao soma os anos);
//   * PROBLEMA DOS 1.000: 3.500 elegiveis + pedido 1.000 = 1.000; 59 elegiveis +
//     pedido 1.000 = 59 com explicacao; mesma previa duas vezes = mesmo resultado;
//   * COBERTURA: so acionamento valido conta; administrativo nao; previa e
//     exportacao nao; fuso America/Sao_Paulo;
//   * FILTROS: operador (todos/livres/um), situacao, acionamento, valor minimo
//     visivel (padrao 0), canal e "sem telefone" no banco, recencia por canal;
//   * PRIORIDADE e determinismo.
import { describe, it, expect, vi } from "vitest";
import {
  novoBanco, alunos, mov, universo, previa, cobertura, drill, executar, exportar,
  OP_A, OP_B, U,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const SOMA = (o) => Object.values(o ?? {}).reduce((s, n) => s + Number(n), 0);
const ids = (r) => r.elegiveis.map((e) => e.id);
const setDe = (arr) => new Set(arr);

// Um titulo a mais em outro ano para os alunos dados (aluno em 2 anos).
async function tituloExtra(db, alunoIds, ano) {
  await db.query(
    `insert into public.acordos_titulos (aluno_id, situacao, vencimento, status)
     select id, 'ABERTO', make_date($2::int, 5, 10), 'em_aberto' from unnest($1::uuid[]) id`,
    [alunoIds, ano]);
}
async function diaDoMesSP(db) {
  return (await db.query(`select extract(day from now() at time zone 'America/Sao_Paulo')::int d`)).rows[0].d;
}

// ---------------------------------------------------------------------------
describe("universo: uma linha por aluno, cobertura separada de disponibilidade", () => {
  it("aluno com varias mensalidades/anos continua sendo UMA linha", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 4, { ano: 2026 });
    await tituloExtra(db, a.slice(0, 2), 2025);
    await tituloExtra(db, a.slice(0, 2), 2026); // 2 titulos no mesmo ano
    const u = await universo(db, {});
    expect(u.length).toBe(4);
    expect(new Set(u.map((x) => x.aluno_id)).size).toBe(4);
    const dois = u.filter((x) => x.anos.length === 2);
    expect(dois.length).toBe(2);
    expect(dois[0].anos).toEqual([2025, 2026]);
  });

  it("acionado e disponivel, sem acionamento e indisponivel: conceitos independentes", async () => {
    const db = await novoBanco();
    const [acionadoDisp, semAcionIndisp, semAcionDisp] = await alunos(db, 3, {});
    await mov(db, acionadoDisp, "FINALIZACAO_ATENDIMENTO", 0);
    await db.query(`update public.alunos set data_retorno = current_date + 5 where id = $1`, [semAcionIndisp]);
    const u = Object.fromEntries((await universo(db, {})).map((x) => [x.aluno_id, x]));
    expect(u[acionadoDisp]).toMatchObject({ acionado_mes: true, disponivel: true, motivo: null });
    expect(u[semAcionIndisp]).toMatchObject({ acionado_mes: false, disponivel: false, motivo: "retorno_futuro" });
    expect(u[semAcionDisp]).toMatchObject({ acionado_mes: false, disponivel: true, nunca_acionado: true });
  });
});

// ---------------------------------------------------------------------------
describe("cobertura: so acionamento valido; administrativo, previa e exportacao nao contam", () => {
  const VALIDOS = ["FINALIZACAO_ATENDIMENTO", "FINALIZACAO", "CONTATO", "LINK_ENVIADO_AO_ALUNO",
    "SOLICITACAO_LINK_PAGAMENTO", "ACAO_MASSIVA_EXTERNA", "ACAO_MASSIVA_EXTERNA_EMAIL"];
  const ADMIN = ["QUITADO_MANUAL", "TERMO_ENVIADO_ADM", "RETORNO_ADM_CRIADO", "RETORNO_ADM_CONCLUIDO",
    "COMPROVANTE_ENVIADO_BAIXA", "OUTRO_TIPO_QUALQUER"];

  it("cada tipo valido conta; cada administrativo nao infla a cobertura", async () => {
    const db = await novoBanco();
    const v = await alunos(db, VALIDOS.length, { ini: 1 });
    const a = await alunos(db, ADMIN.length, { ini: 100 });
    for (let i = 0; i < VALIDOS.length; i++) await mov(db, v[i], VALIDOS[i], 0);
    for (let i = 0; i < ADMIN.length; i++) await mov(db, a[i], ADMIN[i], 0);
    const u = Object.fromEntries((await universo(db, { recencia_dias: 0 })).map((x) => [x.aluno_id, x]));
    for (const id of v) expect(u[id].acionado_mes, `valido ${id}`).toBe(true);
    for (const id of a) {
      expect(u[id].acionado_mes, `admin ${id}`).toBe(false);
      expect(u[id].nunca_acionado).toBe(true);
    }
  });

  it("fuso America/Sao_Paulo: 00:10 do dia 1 conta no mes; 23:50 do mes anterior nao", async () => {
    const db = await novoBanco();
    const [dentro, fora] = await alunos(db, 2, {});
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values
         ($1, 'FINALIZACAO_ATENDIMENTO', (date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') + interval '10 minutes'),
         ($2, 'FINALIZACAO_ATENDIMENTO', (date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') - interval '10 minutes')`,
      [dentro, fora]);
    const u = Object.fromEntries((await universo(db, {})).map((x) => [x.aluno_id, x]));
    expect(u[dentro].acionado_mes).toBe(true);
    expect(u[fora].acionado_mes).toBe(false);
    expect(u[fora].nunca_acionado).toBe(false); // ja foi acionado, so nao neste mes
  });

  it("previa e exportacao NAO contam; so a confirmacao conta", async () => {
    const db = await novoBanco();
    await alunos(db, 6, {});
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 6 });
    expect((await universo(db, {})).filter((x) => x.acionado_mes).length).toBe(0);
    const ex = await exportar(db, ids(p), { canal: "WHATSAPP", previa_id: p.previa_id });
    expect(ex.exportados).toBe(6);
    expect((await universo(db, {})).filter((x) => x.acionado_mes).length).toBe(0);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes`)).rows[0].n).toBe(0);
    await db.query(`select public.acoes_massivas_concluir_lote($1::uuid, 'CONFIRMAR')`, [ex.lote_id]);
    expect((await universo(db, {})).filter((x) => x.acionado_mes).length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe("finalizacao DESFEITA nao conta como acionamento; so o par deterministico invalida", () => {
  async function inserirMov(db, alunoId, tipo, diasAtras = 0) {
    return (await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em)
       values ($1, $2, now() - ($3::numeric || ' days')::interval) returning id`, [String(alunoId), tipo, diasAtras])).rows[0].id;
  }
  const desfeita = (db, movId, quando = "now()") =>
    db.query(`insert into public.acoes_desfazer (tipo, movimentacao_id, desfeito_em, desfeito_por) values ('TABULACAO', $1, ${quando}, 'x')`, [movId]);
  const acionado = async (db, id) => (await universo(db, {})).find((u) => u.aluno_id === id);

  it("como o sistema faz hoje (movimentacao retipada para FINALIZACAO_ATENDIMENTO_DESFEITA): nao conta", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    const id = await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO_DESFEITA");
    await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo) values ($1, 'ACAO_DESFEITA')`, [a]);
    await desfeita(db, id);
    expect(await acionado(db, a)).toMatchObject({ acionado_mes: false, nunca_acionado: true });
  });

  it("par deterministico: FINALIZACAO_ATENDIMENTO referenciada por acoes_desfazer DESFEITA nao conta, mesmo sem ser retipada", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    const id = await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO");
    expect((await acionado(db, a)).acionado_mes).toBe(true);
    await desfeita(db, id);
    expect(await acionado(db, a)).toMatchObject({ acionado_mes: false, nunca_acionado: true });
  });

  it("vale para FINALIZACAO e SOLICITACAO_LINK_PAGAMENTO tambem, quando ha o par", async () => {
    const db = await novoBanco();
    const [a, b] = await alunos(db, 2, {});
    await desfeita(db, await inserirMov(db, a, "FINALIZACAO"));
    await desfeita(db, await inserirMov(db, b, "SOLICITACAO_LINK_PAGAMENTO"));
    for (const id of [a, b]) expect((await acionado(db, id)).acionado_mes).toBe(false);
  });

  it("so invalida A finalizacao desfeita: outra finalizacao valida do mesmo aluno continua contando", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await desfeita(db, await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO", 3));
    expect((await acionado(db, a)).acionado_mes).toBe(false);
    await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO", 1);   // uma segunda, valida
    expect((await acionado(db, a)).acionado_mes).toBe(true);
  });

  it("ACAO_DESFEITA generica, sem vinculo, NAO invalida nenhuma finalizacao", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO");
    await inserirMov(db, a, "ACAO_DESFEITA");
    expect((await acionado(db, a)).acionado_mes).toBe(true);
  });

  it("acao ainda NAO desfeita (desfeito_em nulo) nao invalida; desfeita de outro aluno nao afeta este", async () => {
    const db = await novoBanco();
    const [a, b] = await alunos(db, 2, {});
    const ida = await inserirMov(db, a, "FINALIZACAO_ATENDIMENTO");
    const idb = await inserirMov(db, b, "FINALIZACAO_ATENDIMENTO");
    await db.query(`insert into public.acoes_desfazer (tipo, movimentacao_id, desfeito_em) values ('TABULACAO', $1, null)`, [ida]);
    await desfeita(db, idb);
    expect((await acionado(db, a)).acionado_mes).toBe(true);
    expect((await acionado(db, b)).acionado_mes).toBe(false);
  });

  it("as invariantes continuam valendo com finalizacoes desfeitas na base (reconciliacao e drill-down)", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 30, {});
    for (const id of a.slice(0, 12)) await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    for (const id of a.slice(0, 5)) {
      const m = (await db.query(`select id from public.aluno_movimentacoes where aluno_id = $1 limit 1`, [id])).rows[0].id;
      await desfeita(db, m);
    }
    const c = await cobertura(db, {});
    expect(c.total.acionados).toBe(7);                       // 12 acionados - 5 desfeitos
    expect(c.total.acionados + c.total.sem_acionamento).toBe(c.total.base);
    expect(c.total.disponiveis + SOMA(c.total.motivos)).toBe(c.total.sem_acionamento);
    expect(c.total.reconcilia).toBe(true);
    expect((await drill(db, {}, null, "acionados")).total).toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe("RECONCILIACAO matematica: base, acionados, sem acionamento, disponiveis, motivos, drill-down", () => {
  async function carteiraCompleta() {
    const db = await novoBanco();
    const S = {};
    S.livres2024 = await alunos(db, 12, { ini: 1, ano: 2024 });
    S.livres2025 = await alunos(db, 15, { ini: 20, ano: 2025 });
    S.livres2026 = await alunos(db, 30, { ini: 40, ano: 2026 });
    S.quitado = await alunos(db, 3, { ini: 100, statusJornada: "QUITADO", ano: 2025 });
    S.liquidado = await alunos(db, 4, { ini: 110, liquidado: true, ano: 2026 });
    S.encerrado = await alunos(db, 2, { ini: 120, statusAtual: "JURIDICO" });
    S.conf = await alunos(db, 5, { ini: 130, confirmacao: true, ano: 2026 });
    S.foraTipo = await alunos(db, 3, { ini: 140, acordoEmDia: true, ano: 2025 });
    S.retorno = await alunos(db, 6, { ini: 150, retornoEmDias: 5, ano: 2026 });
    S.outro = await alunos(db, 7, { ini: 160, dono: OP_B, ano: 2026 });
    S.recente = await alunos(db, 4, { ini: 170, ano: 2024 });
    S.semTel = await alunos(db, 5, { ini: 180, semTelefone: true, ano: 2026 });
    S.baixo = await alunos(db, 6, { ini: 190, valor: 10, ano: 2025 });
    // acionados de verdade no mes (varios motivos e anos)
    S.acionados = [...S.livres2024.slice(0, 5), ...S.livres2025.slice(0, 6), ...S.livres2026.slice(0, 9),
                   ...S.outro.slice(0, 2), ...S.retorno.slice(0, 2)];
    for (const id of S.acionados) await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    for (const id of S.recente) await mov(db, id, "ACAO_MASSIVA_EXTERNA", 5);
    // alunos em 2 anos (total por aluno unico nao pode somar as linhas)
    await tituloExtra(db, [...S.livres2026.slice(0, 8), ...S.livres2025.slice(6, 10)], 2024);
    await tituloExtra(db, S.livres2026.slice(10, 14), 2025);
    return { db, S };
  }
  const F = { canal: "WHATSAPP", valor_min: 100, operador: "livres", recencia_dias: 10 };

  it("por ano E no total: acionados + sem = base; disponiveis + soma dos motivos = sem", async () => {
    const { db } = await carteiraCompleta();
    const c = await cobertura(db, F);
    expect(c.linhas.map((l) => l.ano)).toEqual([2024, 2025, 2026]);
    for (const l of [...c.linhas, c.total]) {
      expect(l.acionados + l.sem_acionamento, `ano ${l.ano}`).toBe(l.base);
      expect(l.disponiveis + SOMA(l.motivos), `motivos ano ${l.ano}`).toBe(l.sem_acionamento);
      expect(l.indisponiveis).toBe(SOMA(l.motivos));
      expect(l.reconcilia).toBe(true);
      expect(l.pct_acionado).toBeCloseTo((100 * l.acionados) / l.base, 1);
    }
    // todos os motivos previstos aparecem (nada some sem motivo identificavel).
    // "acao_massiva_recente" fica de fora daqui DE PROPOSITO: quem recebeu acao
    // massiva neste mes ja conta como ACIONADO, entao nao entra na quebra dos
    // "sem acionamento"; ele aparece nas indisponiveis totais (proximo teste).
    const todos = Object.keys(c.total.motivos).sort();
    expect(todos).toEqual([
      "confirmacao_pendente", "contato_indisponivel", "encerrado_operacional",
      "fora_tipo_cobranca", "liquidado_prime", "outro_responsavel", "quitado", "retorno_futuro",
      "valor_fora_da_faixa"].sort());
    const u = await universo(db, F);
    const recentes = u.filter((x) => x.motivo === "acao_massiva_recente");
    expect(recentes.length).toBe(4);
    expect(recentes.every((x) => x.acionado_mes || x.ultimo_massivo)).toBe(true);
    const dt = await drill(db, F, null, "indisponiveis_total", "acao_massiva_recente");
    expect(dt.total).toBe(4);
  });

  it("TOTAL conta ALUNO UNICO: e menor que a soma das linhas quando ha aluno em mais de um ano", async () => {
    const { db } = await carteiraCompleta();
    const c = await cobertura(db, F);
    const soma = c.linhas.reduce((s, l) => s + l.base, 0);
    const u = await universo(db, F);
    expect(c.total.base).toBe(u.length);
    expect(c.total.base).toBeLessThan(soma);
    expect(soma - c.total.base).toBe(u.filter((x) => x.anos.length === 2).length + u.filter((x) => x.anos.length === 3).length * 2);
  });

  it("cobertura e independente dos filtros operacionais: base e acionados nao mudam com canal/valor/operador", async () => {
    const { db } = await carteiraCompleta();
    const a = await cobertura(db, { operador: "livres", valor_min: 0 });
    const b = await cobertura(db, { operador: "todos", valor_min: 100, canal: "EMAIL", recencia_dias: 0 });
    expect(a.total.base).toBe(b.total.base);
    expect(a.total.acionados).toBe(b.total.acionados);
    expect(a.total.sem_acionamento).toBe(b.total.sem_acionamento);
    expect(a.total.disponiveis).not.toBe(b.total.disponiveis); // so a disponibilidade muda
  });

  it("DRILL-DOWN: count da lista = indicador, em cada ano, indicador e motivo; sem duplicidade", async () => {
    const { db } = await carteiraCompleta();
    const c = await cobertura(db, F);
    const u = await universo(db, F);
    const IND = {
      base: () => true,
      acionados: (x) => x.acionado_mes,
      sem_acionamento: (x) => !x.acionado_mes,
      disponiveis: (x) => x.disponivel,
      disponiveis_sem_acionamento: (x) => x.disponivel && !x.acionado_mes,
      indisponiveis: (x) => !x.disponivel && !x.acionado_mes,
      indisponiveis_total: (x) => !x.disponivel,
    };
    const indicadorDaLinha = (l) => ({
      base: l.base, acionados: l.acionados, sem_acionamento: l.sem_acionamento,
      disponiveis_sem_acionamento: l.disponiveis, disponiveis: l.disponiveis_total, indisponiveis: l.indisponiveis,
    });
    for (const linha of [...c.linhas, c.total]) {
      const universoDoAno = linha.ano == null ? u : u.filter((x) => x.anos.includes(linha.ano));
      for (const [ind, valor] of Object.entries(indicadorDaLinha(linha))) {
        const d = await drill(db, F, linha.ano, ind, null, 2000, 0);
        expect(d.total, `${linha.ano}/${ind}`).toBe(valor);
        expect(d.itens.length).toBe(valor);
        expect(new Set(d.itens.map((i) => i.aluno_id)).size).toBe(valor);
        const esperado = setDe(universoDoAno.filter(IND[ind]).map((x) => x.aluno_id));
        expect(setDe(d.itens.map((i) => i.aluno_id))).toEqual(esperado);
      }
      // por motivo (dentro dos sem acionamento)
      for (const [motivo, n] of Object.entries(linha.motivos)) {
        const d = await drill(db, F, linha.ano, "indisponiveis", motivo);
        expect(d.total, `${linha.ano}/${motivo}`).toBe(n);
        expect(d.itens.every((i) => i.motivo === motivo && !i.acionado_mes)).toBe(true);
      }
    }
  });

  it("drill-down pagina sem perder nem repetir ninguem", async () => {
    const { db } = await carteiraCompleta();
    const tudo = await drill(db, F, null, "base", null, 2000, 0);
    const vistos = [];
    for (let off = 0; off < tudo.total; off += 17) {
      const p = await drill(db, F, null, "base", null, 17, off);
      expect(p.total).toBe(tudo.total);
      vistos.push(...p.itens.map((i) => i.aluno_id));
    }
    expect(vistos.length).toBe(tudo.total);
    expect(new Set(vistos).size).toBe(tudo.total);
  });

  it("drill-down nao expoe nome completo nem CPF inteiro", async () => {
    const { db } = await carteiraCompleta();
    const d = await drill(db, F, 2026, "base", null, 5, 0);
    for (const i of d.itens) {
      expect(i.nome).toMatch(/^\S+ \*\*\*$/);
      expect(i.cpf_final).toMatch(/^\d{0,4}$/);
    }
  });

  it("indicador invalido e recusado", async () => {
    const db = await novoBanco();
    await expect(drill(db, {}, null, "qualquer")).rejects.toThrow(/Indicador invalido/);
  });
});

// ---------------------------------------------------------------------------
describe("O PROBLEMA DOS 1.000: o LIMIT so decide quantos, nunca o que se ve", () => {
  it("cenario A: 3.500 elegiveis, pedido 1.000 => 1.000 selecionados", async () => {
    const db = await novoBanco();
    await alunos(db, 3500, { valor: 500 });
    const t0 = Date.now();
    const p = await previa(db, { p_limite: 1000, p_canal: "WHATSAPP" });
    const ms = Date.now() - t0;
    expect(p.resumo.universo_base).toBe(3500);
    expect(p.resumo.elegiveis).toBe(3500);
    expect(p.resumo.selecionado).toBe(1000);
    expect(p.elegiveis.length).toBe(1000);
    expect(p.resumo.menos_que_solicitado).toBe(false);
    expect(new Set(ids(p)).size).toBe(1000);
    expect(ms).toBeLessThan(30000);
  });

  it("cenario B: 59 elegiveis entre 700, pedido 1.000 => 59, e o sistema explica onde estao os outros 641", async () => {
    const db = await novoBanco();
    await alunos(db, 59, { ini: 1 });
    await alunos(db, 200, { ini: 1000, dono: OP_A });            // outro responsavel
    await alunos(db, 150, { ini: 2000, retornoEmDias: 7 });      // retorno futuro
    await alunos(db, 120, { ini: 3000, valor: 20 });             // abaixo do valor minimo
    await alunos(db, 80, { ini: 4000, semTelefone: true });      // sem contato no canal
    await alunos(db, 60, { ini: 5000, confirmacao: true });      // confirmacao pendente
    await alunos(db, 31, { ini: 6000, liquidado: true });        // liquidado no Prime
    const p = await previa(db, { p_limite: 1000, p_canal: "WHATSAPP", p_valor_min: 100 });
    const r = p.resumo;
    expect(r.solicitado).toBe(1000);
    expect(r.universo_base).toBe(700);
    expect(r.elegiveis).toBe(59);
    expect(r.selecionado).toBe(59);
    expect(r.menos_que_solicitado).toBe(true);
    expect(r.indisponiveis).toBe(641);
    expect(r.motivos).toEqual({
      outro_responsavel: 200, retorno_futuro: 150, valor_fora_da_faixa: 120,
      contato_indisponivel: 80, confirmacao_pendente: 60, liquidado_prime: 31,
    });
    // nada some: base = disponiveis + soma dos motivos
    expect(r.disponiveis + SOMA(r.motivos)).toBe(r.universo_base);
  });

  it("cenario C: a mesma previa duas vezes, sem mudar estado, devolve exatamente o mesmo", async () => {
    const db = await novoBanco();
    await alunos(db, 400, { valor: 300 });
    await alunos(db, 100, { ini: 1000, dono: OP_A });
    const a = await previa(db, { p_limite: 120, p_canal: "WHATSAPP" });
    const b = await previa(db, { p_limite: 120, p_canal: "WHATSAPP" });
    expect(ids(a)).toEqual(ids(b));
    const semId = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "previa_id"));
    expect(semId(a)).toEqual(semId(b));
  });

  it("apos confirmar um lote, o proximo traz OUTROS alunos e a explicacao bate (nada aparece 'aos poucos' sem motivo)", async () => {
    const db = await novoBanco();
    await alunos(db, 300, { valor: 300 });
    const x1 = await executar(db, { p_limite: 100 });
    const x2 = await executar(db, { p_limite: 100 });
    expect(x1.confirmacao.registrados).toBe(100);
    expect(x2.confirmacao.registrados).toBe(100);
    expect(new Set([...x1.ids, ...x2.ids]).size).toBe(200); // nenhum repetido
    const p3 = await previa(db, { p_limite: 1000, p_canal: "WHATSAPP" });
    expect(p3.resumo.elegiveis).toBe(100);
    expect(p3.resumo.motivos).toEqual({ acao_massiva_recente: 200 });
  });

  it("nao existe corte antes dos filtros: o universo e o mesmo com limite 1 ou 1.000", async () => {
    const db = await novoBanco();
    await alunos(db, 80, {});
    await alunos(db, 40, { ini: 500, dono: OP_B });
    const p1 = await previa(db, { p_limite: 1 });
    const p2 = await previa(db, { p_limite: 1000 });
    for (const k of ["universo_base", "disponiveis", "elegiveis", "indisponiveis", "motivos"]) {
      expect(p1.resumo[k]).toEqual(p2.resumo[k]);
    }
    expect(p1.resumo.selecionado).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("PRIORIDADE: nao acionados no mes > nunca acionados > mais tempo sem acionamento > saldo > id", () => {
  it("ordem completa, com desempates", async () => {
    const db = await novoBanco();
    const [p1, p2, p3, p4, p5, p6] = await alunos(db, 6, { valor: 100 });
    await db.query(`update public.casos set total_em_aberto = case aluno_id when $1 then 9000 when $2 then 900 when $3 then 800 else 100 end`, [p1, p5, p6]);
    await mov(db, p1, "FINALIZACAO_ATENDIMENTO", 0);           // acionado no mes (saldo alto NAO adianta)
    const fixo = "2026-01-15T12:00:00Z";
    for (const id of [p2, p6]) {
      await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values ($1,'FINALIZACAO_ATENDIMENTO',$2)`, [id, fixo]);
    }
    await mov(db, p3, "FINALIZACAO_ATENDIMENTO", 400);         // o mais antigo de todos (anterior a data fixa)
    // p4 e p5: nunca acionados
    const p = await previa(db, { p_limite: 10, p_canal: "WHATSAPP" });
    expect(ids(p)).toEqual([p5, p4, p3, p6, p2, p1]);
  });

  it("desempate final e o aluno_id, e o limite corta pela prioridade", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 10, { valor: 200 });
    const p = await previa(db, { p_limite: 4 });
    expect(ids(p)).toEqual([...a].sort().slice(0, 4));
  });

  it("filtro 'nao acionados no mes' procura na base INTEIRA antes do limite", async () => {
    const db = await novoBanco();
    const todos = await alunos(db, 200, {});
    // os 150 primeiros (por id) foram acionados no mes: se o limite viesse antes do filtro, sobraria pouco
    for (const id of [...todos].sort().slice(0, 150)) await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    const p = await previa(db, { p_limite: 50, p_acionamento: "NAO_MES" });
    expect(p.resumo.elegiveis).toBe(50);
    expect(p.resumo.selecionado).toBe(50);
    expect(p.elegiveis.every((e) => !e.acionado_mes)).toBe(true);
    // sem o filtro, os nao acionados ainda vem primeiro
    const q = await previa(db, { p_limite: 50 });
    expect(q.elegiveis.every((e) => !e.acionado_mes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("filtros de acionamento", () => {
  it("todos, nao no mes, no mes, nao hoje, hoje, nunca", async () => {
    const db = await novoBanco();
    const [hoje, mesNaoHoje, antigo, nunca] = await alunos(db, 4, {});
    await mov(db, hoje, "FINALIZACAO_ATENDIMENTO", 0);
    await mov(db, antigo, "FINALIZACAO_ATENDIMENTO", 60);
    const temDiaAnterior = (await diaDoMesSP(db)) > 1;
    if (temDiaAnterior) {
      await db.query(
        `insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em)
         values ($1, 'CONTATO', (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') - interval '1 hour')`,
        [mesNaoHoje]);
    }
    const f = async (a) => setDe(ids(await previa(db, { p_limite: 100, p_acionamento: a })));
    expect(await f("TODOS")).toEqual(setDe([hoje, mesNaoHoje, antigo, nunca]));
    expect(await f("NUNCA")).toEqual(setDe([mesNaoHoje, nunca].filter((x) => x === nunca || !temDiaAnterior ? x === nunca : false)));
    expect(await f("HOJE")).toEqual(setDe([hoje]));
    expect(await f("NAO_HOJE")).toEqual(setDe([mesNaoHoje, antigo, nunca]));
    expect(await f("JA")).toEqual(setDe(temDiaAnterior ? [hoje, mesNaoHoje, antigo] : [hoje, antigo]));
    if (temDiaAnterior) {
      expect(await f("MES")).toEqual(setDe([hoje, mesNaoHoje]));
      expect(await f("NAO_MES")).toEqual(setDe([antigo, nunca]));
    } else {
      expect(await f("MES")).toEqual(setDe([hoje]));
      expect(await f("NAO_MES")).toEqual(setDe([antigo, nunca, mesNaoHoje]));
    }
  });

  it("filtro invalido e recusado; a explicacao inclui quantos sairam pelo filtro de acionamento", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 10, {});
    for (const id of a.slice(0, 4)) await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    await expect(previa(db, { p_acionamento: "XPTO" })).rejects.toThrow(/acionamento invalido/i);
    const p = await previa(db, { p_limite: 100, p_acionamento: "NAO_MES" });
    expect(p.resumo.disponiveis).toBe(10);
    expect(p.resumo.elegiveis).toBe(6);
    expect(p.resumo.fora_do_filtro_acionamento).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe("operador: todos, livres, especifico; responsavel/fidelizacao informados", () => {
  async function carteira() {
    const db = await novoBanco();
    const livres = await alunos(db, 20, { ini: 1 });
    const a = await alunos(db, 15, { ini: 100, dono: OP_A, acionadoDias: 3 });   // fidelizacao ativa
    const b = await alunos(db, 12, { ini: 200, dono: OP_B, acionadoDias: 30 });  // fidelizacao vencida
    return { db, livres, a, b };
  }

  it("TODOS seleciona livres e com responsavel; informa quantos tem responsavel e fidelizacao", async () => {
    const { db, livres, a, b } = await carteira();
    const p = await previa(db, { p_limite: 1000, p_operador_email: "TODOS", p_canal: "WHATSAPP" });
    expect(p.resumo.selecionado).toBe(47);
    expect(setDe(ids(p))).toEqual(setDe([...livres, ...a, ...b]));
    expect(p.resumo.com_responsavel).toBe(27);
    expect(p.resumo.com_fidelizacao_ativa).toBe(15);
    expect(p.resumo.motivos.outro_responsavel).toBeUndefined();
    expect(p.operador_email).toBe("todos");
  });

  it("LIVRES so a carteira livre; a de dono aparece como 'fora do responsavel'", async () => {
    const { db, livres } = await carteira();
    const p = await previa(db, { p_limite: 1000, p_operador_email: "LIVRES" });
    expect(setDe(ids(p))).toEqual(setDe(livres));
    expect(p.resumo.motivos).toEqual({ outro_responsavel: 27 });
    expect(p.resumo.com_responsavel).toBe(0);
  });

  it("sem informar operador = livres (compatibilidade)", async () => {
    const { db, livres } = await carteira();
    expect(setDe(ids(await previa(db, { p_limite: 1000 })))).toEqual(setDe(livres));
  });

  it("operador especifico so traz a carteira dele", async () => {
    const { db, a, b } = await carteira();
    expect(setDe(ids(await previa(db, { p_limite: 1000, p_operador_email: OP_A })))).toEqual(setDe(a));
    const pb = await previa(db, { p_limite: 1000, p_operador_email: OP_B });
    expect(setDe(ids(pb))).toEqual(setDe(b));
    expect(pb.resumo.motivos).toEqual({ outro_responsavel: 35 });
  });

  it("confirmar em TODOS nao troca responsavel, nem libera, nem mexe no caso; cada um continua com o seu dono", async () => {
    const { db } = await carteira();
    const antes = await db.query(`select id, responsavel_atual_email, responsavel_atual_em from public.alunos order by id`);
    const casosAntes = await db.query(`select id, operador_email from public.casos order by id`);
    const x = await executar(db, { p_limite: 1000, p_operador_email: "TODOS" });
    expect(x.confirmacao.registrados).toBe(47);
    const depois = await db.query(`select id, responsavel_atual_email, responsavel_atual_em from public.alunos order by id`);
    expect(depois.rows).toEqual(antes.rows);
    expect((await db.query(`select id, operador_email from public.casos order by id`)).rows).toEqual(casosAntes.rows);
  });
});

// ---------------------------------------------------------------------------
describe("valor minimo visivel (padrao 0), canal, 'so sem telefone' e recencia por canal", () => {
  it("valor minimo padrao e R$ 0: quem deve pouco entra; R$ 100 o retira COM motivo, e o filtro fica registrado", async () => {
    const db = await novoBanco();
    await alunos(db, 5, { ini: 1, valor: 50 });
    await alunos(db, 5, { ini: 20, valor: 500 });
    const p0 = await previa(db, { p_limite: 100 });
    expect(p0.resumo.elegiveis).toBe(10);
    expect(p0.resumo.filtros.valor_min).toBe(0);
    const p100 = await previa(db, { p_limite: 100, p_valor_min: 100, p_valor_max: 1000 });
    expect(p100.resumo.elegiveis).toBe(5);
    expect(p100.resumo.motivos).toEqual({ valor_fora_da_faixa: 5 });
    expect(p100.resumo.filtros).toMatchObject({ valor_min: 100, valor_max: 1000 });
    const log = (await db.query(`select filtros, solicitado, selecionado from public.acoes_massivas_previas where id = $1`, [p100.previa_id])).rows[0];
    expect(log.filtros).toMatchObject({ valor_min: 100, valor_max: 1000, operador: "livres" });
    expect(log.solicitado).toBe(100);
    expect(log.selecionado).toBe(5);
  });

  it("valor maximo exclui quem passa dele", async () => {
    const db = await novoBanco();
    await alunos(db, 3, { ini: 1, valor: 500 });
    await alunos(db, 3, { ini: 10, valor: 5000 });
    const p = await previa(db, { p_limite: 100, p_valor_max: 1000 });
    expect(p.resumo.elegiveis).toBe(3);
    expect(p.resumo.motivos).toEqual({ valor_fora_da_faixa: 3 });
  });

  it("canal e 'so sem telefone' agem no BANCO, antes do limite (nao no front depois do corte)", async () => {
    const db = await novoBanco();
    const comAmbos = await alunos(db, 30, { ini: 1 });
    const soEmail = await alunos(db, 4, { ini: 100, semTelefone: true });
    const soTel = await alunos(db, 6, { ini: 200, semEmail: true });
    const wa = await previa(db, { p_limite: 1000, p_canal: "WHATSAPP" });
    expect(setDe(ids(wa))).toEqual(setDe([...comAmbos, ...soTel]));
    expect(wa.resumo.motivos).toEqual({ contato_indisponivel: 4 });
    const em = await previa(db, { p_limite: 1000, p_canal: "EMAIL" });
    expect(setDe(ids(em))).toEqual(setDe([...comAmbos, ...soEmail]));
    // "so sem telefone" no e-mail, com limite MENOR que a base: nao pode sobrar so o corte do meio
    const semTel = await previa(db, { p_limite: 3, p_canal: "EMAIL", p_sem_telefone: true });
    expect(semTel.resumo.elegiveis).toBe(4);
    expect(semTel.resumo.selecionado).toBe(3);
    expect(semTel.elegiveis.every((e) => !e.tem_telefone)).toBe(true);
    expect(semTel.resumo.motivos).toEqual({ contato_indisponivel: 36 });
  });

  it("RECENCIA por canal: WhatsApp recente bloqueia WhatsApp, nao e-mail; usa so acao CONFIRMADA", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await mov(db, a, "ACAO_MASSIVA_EXTERNA", 3);
    const wa = await previa(db, { p_limite: 10, p_canal: "WHATSAPP" });
    expect(wa.resumo.motivos).toEqual({ acao_massiva_recente: 1 });
    const em = await previa(db, { p_limite: 10, p_canal: "EMAIL" });
    expect(ids(em)).toEqual([a]);
    // fronteira: 3 dias atras libera com recencia 3, bloqueia com 4
    expect(ids(await previa(db, { p_limite: 10, p_canal: "WHATSAPP", p_recencia_dias: 3 }))).toEqual([a]);
    expect((await previa(db, { p_limite: 10, p_canal: "WHATSAPP", p_recencia_dias: 4 })).resumo.motivos).toEqual({ acao_massiva_recente: 1 });
    expect(ids(await previa(db, { p_limite: 10, p_canal: "WHATSAPP", p_recencia_dias: 0 }))).toEqual([a]);
  });

  it("recencia: e-mail massivo recente bloqueia e-mail; contato do operador NAO conta como acao massiva", async () => {
    const db = await novoBanco();
    const [a, b] = await alunos(db, 2, {});
    await mov(db, a, "ACAO_MASSIVA_EXTERNA_EMAIL", 2);
    await mov(db, b, "FINALIZACAO_ATENDIMENTO", 0);
    const em = await previa(db, { p_limite: 10, p_canal: "EMAIL" });
    expect(ids(em)).toEqual([b]);
    expect(em.resumo.motivos).toEqual({ acao_massiva_recente: 1 });
    expect(setDe(ids(await previa(db, { p_limite: 10, p_canal: "WHATSAPP" })))).toEqual(setDe([a, b]));
  });

  it("recencia fora de 0..60 e recusada; exportar sem confirmar nao cria recencia", async () => {
    const db = await novoBanco();
    await alunos(db, 3, {});
    await expect(previa(db, { p_recencia_dias: 61 })).rejects.toThrow(/entre 0 e 60/);
    await expect(previa(db, { p_recencia_dias: -1 })).rejects.toThrow(/entre 0 e 60/);
    const p = await previa(db, { p_limite: 10, p_canal: "WHATSAPP" });
    await exportar(db, ids(p), { previa_id: p.previa_id });
    expect((await previa(db, { p_limite: 10, p_canal: "WHATSAPP" })).resumo.elegiveis).toBe(3);
  });

  it("recencia nao cria retorno nem mexe no aluno: e leitura das movimentacoes", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await mov(db, a, "ACAO_MASSIVA_EXTERNA", 1);
    const antes = (await db.query(`select data_retorno, data_ultimo_acionamento, status_acionamento from public.alunos where id=$1`, [a])).rows[0];
    await previa(db, { p_limite: 10, p_canal: "WHATSAPP" });
    expect((await db.query(`select data_retorno, data_ultimo_acionamento, status_acionamento from public.alunos where id=$1`, [a])).rows[0]).toEqual(antes);
  });
});

// ---------------------------------------------------------------------------
describe("protecoes preservadas: retorno futuro, acordo em dia, liquidado, quitado, confirmacao, encerrado", () => {
  it("nenhum deles e selecionado, em nenhum modo de operador", async () => {
    const db = await novoBanco();
    const bons = await alunos(db, 3, { ini: 1 });
    const ruins = [
      ...(await alunos(db, 1, { ini: 50, retornoEmDias: 3 })),
      ...(await alunos(db, 1, { ini: 60, acordoEmDia: true })),
      ...(await alunos(db, 1, { ini: 70, liquidado: true })),
      ...(await alunos(db, 1, { ini: 80, statusJornada: "QUITADO" })),
      ...(await alunos(db, 1, { ini: 90, statusAtual: "QUITADO_MANUAL" })),
      ...(await alunos(db, 1, { ini: 100, confirmacao: true })),
      ...(await alunos(db, 1, { ini: 110, situacaoOperacional: "AGUARDANDO_CONFIRMACAO" })),
      ...(await alunos(db, 1, { ini: 120, statusAtual: "JURIDICO" })),
    ];
    for (const op of ["TODOS", "LIVRES", undefined]) {
      const p = await previa(db, { p_limite: 100, ...(op ? { p_operador_email: op } : {}) });
      expect(setDe(ids(p)), `op=${op}`).toEqual(setDe(bons));
      expect(p.resumo.motivos).toEqual({
        retorno_futuro: 1, fora_tipo_cobranca: 1, liquidado_prime: 1, quitado: 2,
        confirmacao_pendente: 2, encerrado_operacional: 1 });
      expect(p.resumo.disponiveis + SOMA(p.resumo.motivos)).toBe(p.resumo.universo_base);
    }
    void ruins;
  });

  it("nada disso e alterado por executar a acao (financeiro, acordos, parcelas, titulos, retorno)", async () => {
    const db = await novoBanco();
    await alunos(db, 20, {});
    await alunos(db, 5, { ini: 100, acordoEmDia: true });
    await alunos(db, 5, { ini: 200, retornoEmDias: 4 });
    const foto = async () => JSON.stringify([
      (await db.query(`select * from public.acordos_titulos order by id`)).rows,
      (await db.query(`select * from public.acordos order by id`)).rows,
      (await db.query(`select * from public.parcelas order by id`)).rows,
      (await db.query(`select id, data_retorno, retorno_origem, status_acionamento, responsavel_atual_email, data_ultimo_acionamento from public.alunos order by id`)).rows,
      (await db.query(`select * from public.casos order by id`)).rows]);
    const antes = await foto();
    const x = await executar(db, { p_limite: 100, p_operador_email: "TODOS" });
    expect(x.confirmacao.registrados).toBe(20);
    expect(await foto()).toBe(antes);
  });
});

// ---------------------------------------------------------------------------
describe("situacoes: todas ou especificas, so as que existem", () => {
  it("vazio = TODAS; lista com '|' = so as escolhidas", async () => {
    const db = await novoBanco();
    const m = await alunos(db, 4, { ini: 1, situacao: "Matriculado" });
    const t = await alunos(db, 3, { ini: 20, situacao: "Trancado" });
    const c = await alunos(db, 2, { ini: 40, situacao: "Cancelado" });
    expect((await previa(db, { p_limite: 100 })).resumo.elegiveis).toBe(9);
    expect(setDe(ids(await previa(db, { p_limite: 100, p_situacao_academica: "Matriculado|Trancado" })))).toEqual(setDe([...m, ...t]));
    expect(setDe(ids(await previa(db, { p_limite: 100, p_situacao_academica: "Cancelado" })))).toEqual(setDe(c));
  });

  it("filtro de POPULACAO (situacao) reduz a base; filtro OPERACIONAL vira motivo (base nao muda)", async () => {
    const db = await novoBanco();
    await alunos(db, 4, { ini: 1, situacao: "Matriculado" });
    await alunos(db, 3, { ini: 20, situacao: "Trancado", dono: OP_A });
    const pop = await previa(db, { p_limite: 100, p_situacao_academica: "Matriculado" });
    expect(pop.resumo.universo_base).toBe(4);
    const oper = await previa(db, { p_limite: 100, p_operador_email: "LIVRES" });
    expect(oper.resumo.universo_base).toBe(7);
    expect(oper.resumo.motivos).toEqual({ outro_responsavel: 3 });
  });
});

// ---------------------------------------------------------------------------
describe("acesso e contrato", () => {
  it("previa, universo, cobertura e drill-down exigem gestao", async () => {
    const db = await novoBanco();
    await alunos(db, 2, {});
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email: OP_A, role: "authenticated" })]);
    await expect(previa(db, {})).rejects.toThrow(/restrita a gestao/);
    await expect(universo(db, {})).rejects.toThrow(/restrito a gestao/);
    await expect(cobertura(db, {})).rejects.toThrow(/restrita a gestao/);
    await expect(drill(db, {}, null, "base")).rejects.toThrow(/restrito a gestao/);
  });

  it("anon nao executa nenhuma das funcoes novas", async () => {
    const db = await novoBanco();
    const r = await db.query(`
      select p.proname, has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('authenticated', p.oid, 'execute') auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('acoes_massivas_universo','acoes_massivas_cobertura_por_ano',
         'acoes_massivas_drilldown','acoes_massivas_previa','registrar_acao_massiva','acoes_massivas_exportar',
         'acoes_massivas_concluir_lote')`);
    expect(r.rows.length).toBe(7);
    for (const x of r.rows) {
      expect(x.anon, x.proname).toBe(false);
      expect(x.auth, x.proname).toBe(true);
    }
  });

  it("tipo de cobranca invalido e canal invalido sao recusados", async () => {
    const db = await novoBanco();
    await expect(previa(db, { p_tipo_cobranca: "XYZ" })).rejects.toThrow(/Tipo de cobranca invalido/);
    await expect(previa(db, { p_canal: "SMS" })).rejects.toThrow(/Canal invalido/);
  });
});

void U;
