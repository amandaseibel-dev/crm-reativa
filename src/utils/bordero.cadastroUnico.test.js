// O defeito do borderô 723 (08/10/2026): 14 CPFs com 2 a 5 fichas cada, 33
// fichas no total, porque os cadastros novos eram montados a partir das LINHAS
// do arquivo — e o borderô tem uma linha por título, não por aluno.
//
// Estes testes fixam a invariante que faltava:
//
//   nº de fichas criadas  ==  nº de CPFs distintos sem cadastro
//
// e não "nº de linhas".
//
// CPFs E NOMES AQUI SÃO FICTÍCIOS. O repositório é público e a §7 de
// docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md manda mascarar CPF e não
// registrá-lo. O que os testes reproduzem dos casos reais é a FORMA — quantas
// linhas por CPF, e CPF escrito de jeitos diferentes —, nunca o dado.
import { describe, it, expect } from "vitest";
import {
  chaveCpf, indexarAlunosPorCpf, fichasParaCriar, alunoDaLinha, motivoDeNaoTocar,
} from "./bordero";

// CPFs fictícios, com zero à esquerda de propósito: é o formato que quebrava.
const CPF_A = "01234567890";
const CPF_B = "09876543210";

const linha = (cpfLimpo, nome, extra = {}) => ({
  cpfLimpo, nome, aluno: null, curso: "Cursos de Graduação Presencial",
  unidade: "CAMPUS CANOAS", email: null, telefone: null, ...extra,
});

describe("chaveCpf — a identidade é o CPF, com zeros à esquerda", () => {
  it("tira máscara e preserva zero à esquerda", () => {
    expect(chaveCpf("012.345.678-90")).toBe(CPF_A);
    expect(chaveCpf("1234567890")).toBe(CPF_A);
    expect(chaveCpf(1234567890)).toBe(CPF_A);
  });

  it("sem dígito nenhum não há chave — e não se inventa uma", () => {
    expect(chaveCpf("")).toBeNull();
    expect(chaveCpf(null)).toBeNull();
    expect(chaveCpf(undefined)).toBeNull();
    expect(chaveCpf("sem cpf")).toBeNull();
  });
});

describe("indexarAlunosPorCpf — acha o cadastro que já existe", () => {
  // 09/10/2026: 32 fichas gravadas com máscara e 10 com contagem de dígitos
  // diferente de 11. A busca antiga comparava o CPF normalizado do arquivo com
  // a coluna crua e não achava nenhuma delas — criava cadastro novo para quem
  // já estava na base.
  it("indexa por chave, não pelo valor cru da coluna", () => {
    const mapa = indexarAlunosPorCpf([
      { id: "a1", cpf: "012.345.678-90", nome: "Aluna A" },
      { id: "a2", cpf: "9876543210", nome: "Aluno B" },
    ]);
    expect(mapa[CPF_A].id).toBe("a1");
    expect(mapa[CPF_B].id).toBe("a2");
  });

  it("ficha sem CPF não entra no índice", () => {
    expect(indexarAlunosPorCpf([{ id: "a1", cpf: null }])).toEqual({});
  });

  it("CPF com mais de uma ficha: reaproveita a primeira, não escolhe dona", () => {
    const mapa = indexarAlunosPorCpf([
      { id: "fica", cpf: CPF_A },
      { id: "outra", cpf: CPF_A },
    ]);
    expect(Object.keys(mapa)).toHaveLength(1);
    expect(mapa[CPF_A].id).toBe("fica");
  });
});

describe("fichasParaCriar — um cadastro por CPF, não um por linha", () => {
  // REGRESSÃO: a aluna corrigida em 09/10/2026 tinha 6 mensalidades em aberto,
  // 6 linhas no borderô — e ganhou 6 fichas.
  it("6 títulos do mesmo CPF criavam 6 fichas, agora criam 1", () => {
    const seisLinhas = ["1001", "1002", "1003", "1004", "1005", "1006"]
      .map((doc) => linha(CPF_A, "Aluna A", { numTitulo: doc }));

    const { registros } = fichasParaCriar(seisLinhas);

    expect(registros).toHaveLength(1);
    expect(registros[0].cpf).toBe(CPF_A);
    expect(registros[0].nome).toBe("Aluna A");
    expect(registros[0].status_atual).toBe("CONTATAR");
  });

  it("os 14 CPFs do borderô 723 viram 14 fichas, não 33", () => {
    // as QUANTIDADES são as medidas em produção (1 CPF com 5 linhas, 2 com 3,
    // 11 com 2 = 33 linhas); os CPFs são sequenciais e fictícios.
    const quantidades = [5, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
    const linhas = quantidades.flatMap((n, i) => {
      const cpf = String(i + 1).padStart(11, "0");
      return Array.from({ length: n }, (_, j) =>
        linha(cpf, `Aluno ${i + 1}`, { numTitulo: `${i + 1}-${j}` }));
    });
    expect(linhas).toHaveLength(33);

    const { registros } = fichasParaCriar(linhas);
    expect(registros).toHaveLength(14);
    expect(new Set(registros.map((r) => r.cpf)).size).toBe(14);
  });

  it("quem já tem cadastro não ganha ficha nova", () => {
    const existe = { id: "existe", cpf: CPF_A };
    const linhas = [
      linha(CPF_A, "Aluna A", { aluno: existe }),
      linha(CPF_A, "Aluna A", { aluno: existe }),
    ];
    expect(fichasParaCriar(linhas).registros).toHaveLength(0);
  });

  it("mesma pessoa com o CPF escrito de dois jeitos é UM cadastro", () => {
    const { registros } = fichasParaCriar([
      linha(CPF_A, "Aluna A"),
      linha("1234567890", "Aluna A"),
      linha("012.345.678-90", "Aluna A"),
    ]);
    expect(registros).toHaveLength(1);
    expect(registros[0].cpf).toBe(CPF_A);
  });

  it("CPFs diferentes continuam sendo cadastros diferentes", () => {
    const { registros } = fichasParaCriar([
      linha(CPF_A, "Aluna A"),
      linha(CPF_B, "Aluno B"),
    ]);
    expect(registros).toHaveLength(2);
  });

  it("linha sem CPF fica de fora de `registros` e é devolvida à parte", () => {
    const semCpf = linha(null, "Sem CPF na planilha");
    const { registros, linhasSemCpf } = fichasParaCriar([semCpf, linha(CPF_A, "Aluna A")]);
    expect(registros).toHaveLength(1);
    expect(registros[0].cpf).toBe(CPF_A);
    expect(linhasSemCpf).toEqual([semCpf]);
  });

  it("preserva a ordem da primeira aparição de cada CPF", () => {
    const { registros, cpfsNovos } = fichasParaCriar([
      linha(CPF_B, "Aluno B"),
      linha(CPF_A, "Aluna A"),
      linha(CPF_B, "Aluno B"),
    ]);
    expect(registros.map((r) => r.cpf)).toEqual([CPF_B, CPF_A]);
    expect(cpfsNovos).toEqual([CPF_B, CPF_A]);
  });

  it("lote vazio não explode", () => {
    expect(fichasParaCriar([]).registros).toEqual([]);
    expect(fichasParaCriar(null).registros).toEqual([]);
  });
});

describe("alunoDaLinha — todo título do CPF cai na MESMA ficha", () => {
  it("as 6 linhas do mesmo CPF apontam para o único cadastro criado", () => {
    const seisLinhas = ["1001", "1002", "1003", "1004", "1005", "1006"]
      .map((doc) => linha(CPF_A, "Aluna A", { numTitulo: doc }));

    // simula o que o banco devolve depois do insert
    const criado = { id: "ficha-1", cpf: CPF_A, nome: "Aluna A" };
    const mapaNovos = indexarAlunosPorCpf([criado]);

    const ids = seisLinhas.map((l) => alunoDaLinha(l, mapaNovos)?.id);
    expect(ids).toEqual(Array(6).fill("ficha-1"));
    expect(new Set(ids).size).toBe(1);
  });

  it("casa mesmo quando o cadastro voltou com o CPF em outro formato", () => {
    const mapaNovos = indexarAlunosPorCpf([{ id: "a1", cpf: "1234567890" }]);
    expect(alunoDaLinha(linha(CPF_A, "Aluna A"), mapaNovos).id).toBe("a1");
  });

  it("cadastro do preview tem precedência sobre o recém-criado", () => {
    const doPreview = { id: "existe", cpf: CPF_A };
    const l = linha(CPF_A, "Aluna A", { aluno: doPreview });
    expect(alunoDaLinha(l, indexarAlunosPorCpf([{ id: "novo", cpf: CPF_A }])).id)
      .toBe("existe");
  });

  it("linha sem CPF não se liga a cadastro por chave (a tela trata à parte)", () => {
    expect(alunoDaLinha(linha(null, "Sem CPF"), { [CPF_A]: { id: "a1" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REIMPORTAÇÃO DO MESMO BORDERÔ
// ---------------------------------------------------------------------------
//
// É o caminho mais provável de voltar a duplicar: o arquivo é reenviado (de
// propósito, como reforço de dados, ou sem perceber — a tela avisa mas não
// bloqueia). Na segunda passada, o preview JÁ ACHA os alunos criados na
// primeira; o que precisa ser verdade é que nada nasça de novo e nenhum título
// existente seja tocado.
//
// As duas metades estão testadas junto porque é a soma delas que dá a garantia:
// `fichasParaCriar` não cria cadastro, e `motivoDeNaoTocar` recusa o título.
describe("reimportar o mesmo borderô não duplica nem reabre", () => {
  // o estado do CRM depois da primeira importação: uma ficha, 6 títulos
  const fichaCriada = { id: "ficha-1", cpf: CPF_A, nome: "Aluna A" };
  const DOCS = ["1001", "1002", "1003", "1004", "1005", "1006"];

  // a segunda passada do MESMO arquivo, já com o aluno resolvido pelo preview
  const segundaPassada = DOCS.map((doc) => linha(CPF_A, "Aluna A", {
    numTitulo: doc, aluno: fichaCriada, jaExiste: true,
    situacaoAtual: "ABERTO", statusAtual: "em_aberto",
  }));

  it("nenhuma ficha nova nasce na segunda passada", () => {
    const { registros, linhasSemCpf } = fichasParaCriar(segundaPassada);
    expect(registros).toEqual([]);
    expect(linhasSemCpf).toEqual([]);
  });

  it("as 6 linhas continuam apontando para a MESMA ficha da primeira passada", () => {
    const ids = segundaPassada.map((l) => alunoDaLinha(l, {})?.id);
    expect(ids).toEqual(Array(6).fill("ficha-1"));
  });

  it("nenhum dos 6 títulos é tocado: o importador é insert-only", () => {
    for (const l of segundaPassada) {
      expect(motivoDeNaoTocar(l)).toBe("título já existe (a importação não atualiza existente)");
    }
  });

  it("título já negociado/pago não volta a ABERTO nem na reimportação", () => {
    const negociado = { ...segundaPassada[0], situacaoAtual: "NEGOCIADO" };
    const pago = { ...segundaPassada[1], situacaoAtual: "PAGO" };
    const quitada = { ...segundaPassada[2], situacaoAtual: "VENCIDA", statusAtual: "quitada" };
    expect(motivoDeNaoTocar(negociado)).toBe("situação NEGOCIADO");
    expect(motivoDeNaoTocar(pago)).toBe("situação PAGO");
    expect(motivoDeNaoTocar(quitada)).toBe("status quitada");
  });

  it("mensalidade NOVA do mesmo aluno entra na ficha que já existe, sem criar outra", () => {
    const comNova = [
      ...segundaPassada,
      linha(CPF_A, "Aluna A", { numTitulo: "1007", aluno: fichaCriada, jaExiste: false }),
    ];
    expect(fichasParaCriar(comNova).registros).toEqual([]);
    const nova = comNova[comNova.length - 1];
    expect(motivoDeNaoTocar(nova)).toBeNull();
    expect(alunoDaLinha(nova, {}).id).toBe("ficha-1");
  });

  it("reimportação com o CPF em outro formato não cria ficha paralela", () => {
    // o arquivo volta com máscara; a ficha no CRM está sem zero à esquerda
    const mapa = indexarAlunosPorCpf([{ id: "ficha-1", cpf: "1234567890" }]);
    const linhas = DOCS.map((doc) => {
      const l = linha("012.345.678-90", "Aluna A", { numTitulo: doc });
      return { ...l, aluno: mapa[chaveCpf(l.cpfLimpo)] || null };
    });
    expect(fichasParaCriar(linhas).registros).toEqual([]);
    expect(new Set(linhas.map((l) => alunoDaLinha(l, {}).id))).toEqual(new Set(["ficha-1"]));
  });
});
