// @vitest-environment jsdom
//
// O PAINEL DE CONFERÊNCIA — o que a gestão precisa ver ANTES de encerrar.
//
// Na primeira abertura real da prévia em produção (27/10/2026), o painel
// mostrava as 8 validações e o resultado, e não mostrava: quem é o aluno, qual
// é o acordo, e como a parcela virou PAGO. Pior, o motivo histórico do motor
// ("nao ha registro de quem baixou") era lido como ausência de rastro, quando
// `parcelas.observacao` registra o documento que a baixou.
//
// O que se prova aqui:
//   1. a prévia exibe identificação (aluno + acordo) e o histórico da baixa;
//   2. o motivo do motor e a evidência de hoje têm rótulos SEPARADOS;
//   3. o documento citado é descrito, nunca atribuído a outra parcela;
//   4. o painel declara que encerrar NÃO preenche `origem_baixa_ref`;
//   5. o que falta vira "não informado — conferir", nunca um vínculo inventado;
//   6. abrir a prévia NÃO confirma nada -- a confirmação é outro botão.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import EncaminharPendencia from "./EncaminharPendencia";
import { NAO_DISPONIVEL, NAO_INFORMADO } from "../utils/encaminhamentoConciliacao";

const moeda = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

// A linha elegível, como a triagem a devolve.
const TRIAGEM = {
  pagamento_id: "79d79210",
  categoria: "ACIONAVEL_ADMINISTRATIVO",
  subcategoria: "ja_paga_conferir_e_encerrar",
  acao_sugerida: "CONFERIR_E_ENCERRAR",
  decisao: null,
  valor_pago: 126.18,
};

// A prévia do caso real do acordo 66247.
const PREVIA = {
  ok: true,
  gravou: false,
  modo: "PREVIA",
  acao: "CONFERIR_E_ENCERRAR",
  aprovado: true,
  bloqueios: [],
  validacoes: [{ codigo: "BOLETO_NO_PADRAO", ok: true, detalhe: "boleto 50662470003" }],
  motivo_da_pendencia:
    "a parcela 2 do boleto 50662470003 ja estava PAGO antes deste pagamento entrar: nao ha registro de quem baixou",
  // CPF já mascarado: é o que a fachada manda, mascarado na origem (§7).
  aluno: { id: "a1", nome: "Julia Gabriela Cerqueira Amorim", cpf: "***.***.***-00" },
  acordo: { id: "ac1", numero_ulbra: "66247", status: "ATIVO", qtd_parcelas: 6 },
  parcela: {
    id: "p1", numero: 2, boleto: "50662470003", valor: 122.36,
    pago_em: "2026-08-05T00:00:00+00:00", confirmado_por_email: "ADEMIR.SANTOS",
    origem_baixa: null, origem_baixa_ref: null,
  },
  parcela_observacao: "baixa automatica pelo documento 50662470002 (extrato de 05/08/2026)",
  pagamento: { boleto: "50662470003", valor_pago: 126.18 },
  passos: ["REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO", "MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO"],
  resultado_esperado: "PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO",
  efeito_financeiro: false,
};

function montar(previa = PREVIA) {
  rpcMock.mockImplementation((nome) => {
    if (nome === "conciliacao_encaminhar_previa") return Promise.resolve({ data: previa, error: null });
    return Promise.resolve({ data: null, error: { message: "rpc inesperada: " + nome } });
  });
  return render(<EncaminharPendencia triagem={TRIAGEM} moeda={moeda} onConcluido={() => {}} />);
}

async function abrirPrevia() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /conferir e encerrar/i }));
  });
}

beforeEach(() => rpcMock.mockReset());
afterEach(cleanup);

describe("a prévia mostra quem é o aluno e qual o acordo", () => {
  it("exibe nome, CPF mascarado, número e situação do acordo", async () => {
    montar();
    await abrirPrevia();

    expect(screen.getByText(/Julia Gabriela Cerqueira Amorim/)).toBeTruthy();
    expect(screen.getByText(/\*\*\*\.\*\*\*\.\*\*\*-00/)).toBeTruthy();
    expect(screen.getByText(/66247 · ATIVO · 6 parcelas/)).toBeTruthy();
  });

  // A TELA NÃO É A BARREIRA -- a fachada é. O que se prova aqui é que o
  // payload não traz CPF completo, e que a tela não o reconstrói.
  it("nenhum CPF completo trafega nem aparece", async () => {
    expect(JSON.stringify(PREVIA.aluno)).not.toMatch(/\d{11}/);
    montar();
    await abrirPrevia();
    // Só o campo do aluno: boleto também tem 11 dígitos e aparece de propósito.
    // O texto é buscado pelo nome, que é único na tela -- "CPF" não é.
    const linha = screen.getByText(/Julia Gabriela Cerqueira Amorim/).textContent;
    expect(linha).toMatch(/CPF/);
    expect(linha).not.toMatch(/\d{3}\D*\d{3}/);
  });
});

describe("o histórico da baixa anterior", () => {
  it("mostra data, responsável e o documento citado na observação", async () => {
    montar();
    await abrirPrevia();

    expect(screen.getByText("2026-08-05")).toBeTruthy();
    expect(screen.getByText("ADEMIR.SANTOS")).toBeTruthy();
    // O documento aparece DUAS vezes, e é assim que tem de ser: no campo
    // próprio, destacado, e dentro da observação que o banco guarda. Uma é o
    // dado extraído; a outra é a frase original, que não se reescreve.
    expect(screen.getAllByText(/50662470002/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/baixa automatica pelo documento 50662470002/)).toBeTruthy();
  });

  // REPROVAÇÃO DO GUARDIÃO (27/10/2026): a tela não pode concluir de qual
  // parcela é o documento. Os 4 dígitos finais são sequência de emissão, não o
  // número da parcela. O que ela diz é o que viu, e pede conferência.
  it("descreve o documento sem dizer de qual parcela ele é", async () => {
    montar();
    await abrirPrevia();

    expect(screen.getByText(/difere do boleto apresentado; conferir/)).toBeTruthy();
    expect(screen.queryByText(/OUTRA parcela/i)).toBeNull();
  });

  it("documento igual ao boleto não recebe a frase de divergência", async () => {
    montar({
      ...PREVIA,
      parcela_observacao: "baixa automatica pelo documento 50662470003 (extrato)",
    });
    await abrirPrevia();
    expect(screen.queryByText(/difere do boleto apresentado/)).toBeNull();
    expect(screen.getByText("Documento citado na observação")).toBeTruthy();
  });
});

describe("o histórico do motor não é reescrito", () => {
  it("o motivo aparece com rótulo próprio, separado da evidência atual", async () => {
    montar();
    await abrirPrevia();

    expect(screen.getByText(/o que o motor registrou na importação/i)).toBeTruthy();
    expect(screen.getByText(/o que o banco guarda hoje sobre esta parcela/i)).toBeTruthy();
    // E o texto do motor passa intacto, inclusive a parte que parecia enganosa.
    expect(screen.getByText(/nao ha registro de quem baixou/)).toBeTruthy();
  });
});

describe("o painel declara o limite do encerramento", () => {
  it("avisa que origem_baixa_ref não é preenchida", async () => {
    montar();
    await abrirPrevia();
    expect(screen.getByText(/não preenche origem_baixa_ref/i)).toBeTruthy();
  });

  it("mantém o aviso de que nada de dinheiro é movido", async () => {
    montar();
    await abrirPrevia();
    expect(screen.getByText(/não dá baixa, não quita, não vincula aluno/i)).toBeTruthy();
  });
});

describe("o que falta vira pendência, nunca vínculo inventado", () => {
  // Enquanto a fachada não mandar o bloco `aluno`, a tela diz que falta — e
  // continua mostrando o acordo, que já vem hoje.
  it("sem o bloco aluno, diz que a prévia não manda o campo e mantém o acordo", async () => {
    const { aluno, ...semAluno } = PREVIA;
    expect(aluno).toBeTruthy();
    montar(semAluno);
    await abrirPrevia();

    expect(screen.getAllByText(new RegExp(NAO_DISPONIVEL)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/66247 · ATIVO/)).toBeTruthy();
    expect(screen.queryByText(/Julia Gabriela/)).toBeNull();
  });

  it("sem observação, não inventa documento", async () => {
    const { parcela_observacao, ...semObs } = PREVIA;
    expect(parcela_observacao).toBeTruthy();
    montar(semObs);
    await abrirPrevia();

    expect(screen.queryByText(/50662470002/)).toBeNull();
    expect(screen.queryByText(/difere do boleto apresentado/)).toBeNull();
    // o que já vem hoje continua aparecendo
    expect(screen.getByText("2026-08-05")).toBeTruthy();
  });

  it("origem_baixa_ref nula aparece como pendência, não como vazio", async () => {
    montar();
    await abrirPrevia();
    const pendencias = screen.getAllByText(new RegExp(NAO_INFORMADO));
    expect(pendencias.length).toBeGreaterThanOrEqual(1);
  });
});

describe("abrir a prévia não confirma nada", () => {
  it("a RPC chamada é a da prévia, nunca a de confirmar", async () => {
    montar();
    await abrirPrevia();

    const chamadas = rpcMock.mock.calls.map((c) => c[0]);
    expect(chamadas).toContain("conciliacao_encaminhar_previa");
    expect(chamadas).not.toContain("conciliacao_encaminhar_confirmar");
  });

  it("a confirmação é outro botão, e ele só existe depois da prévia", async () => {
    montar();
    expect(screen.queryByRole("button", { name: /encerrar a pendência/i })).toBeNull();
    await abrirPrevia();
    expect(screen.getByRole("button", { name: /encerrar a pendência/i })).toBeTruthy();
  });
});
