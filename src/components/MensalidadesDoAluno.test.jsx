// @vitest-environment jsdom
//
// O conserto da caixinha "Mensalidades" na Minha Carteira (22/10/2026).
//
// O teste central e o do CLIQUE: a caixa vive dentro de uma <tr> que abre o
// atendimento, e era justamente por isso que ela "nao abria" -- o clique subia
// para a linha. Aqui a arvore reproduz esse arranjo (linha com onClick + botao
// dentro dela) e exige as duas coisas ao mesmo tempo: o detalhamento abre E o
// atendimento NAO e disparado.
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BotaoMensalidades, LinhaMensalidades } from "./MensalidadesDoAluno";

afterEach(cleanup);

const M = (o) => ({
  documento: "1001",
  competencia: "05/2026",
  vencimento: "2026-05-10",
  valor: 180.5,
  vencida: true,
  ...o,
});

// Mesmo arranjo da tabela da Minha Carteira: a linha do aluno abre o
// atendimento, o botao mora numa celula dela e o detalhamento vem na linha de
// baixo.
function Linha({ itens, onAbrirAtendimento }) {
  const [aberto, setAberto] = useState(false);
  return (
    <table>
      <tbody>
        <tr onClick={onAbrirAtendimento}>
          <td>
            <BotaoMensalidades
              qtd={itens.length}
              valorRotulo="R$ 300,00"
              aberto={aberto}
              idPainel="pcm-a1"
              onAlternar={() => setAberto((v) => !v)}
            />
          </td>
        </tr>
        {aberto && (
          <LinhaMensalidades
            id="pcm-a1"
            colSpan={8}
            nome="Aluna Teste"
            itens={itens}
            totalRotulo="R$ 300,00"
          />
        )}
      </tbody>
    </table>
  );
}

describe("caixinha Mensalidades: clique e expansao", () => {
  it("o clique abre o detalhamento e NAO abre o atendimento da linha", () => {
    const atendimento = vi.fn();
    render(<Linha itens={[M()]} onAbrirAtendimento={atendimento} />);

    expect(screen.queryByTestId("linha-mensalidades")).toBeNull();
    fireEvent.click(screen.getByTestId("botao-mensalidades"));

    expect(screen.getByTestId("linha-mensalidades")).toBeTruthy();
    // A regra que o relato da operacao exige preservar: a titularidade e o
    // atendimento continuam onde estavam -- a caixa nao rouba o clique da linha
    // nem o entrega a ela.
    expect(atendimento).not.toHaveBeenCalled();
  });

  it("o segundo clique fecha, e o botao diz em que estado esta", () => {
    render(<Linha itens={[M()]} onAbrirAtendimento={() => {}} />);
    const botao = screen.getByTestId("botao-mensalidades");
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    expect(botao.getAttribute("aria-controls")).toBe("pcm-a1");

    fireEvent.click(botao);
    expect(screen.getByTestId("botao-mensalidades").getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("pcm-a1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("botao-mensalidades"));
    expect(screen.queryByTestId("linha-mensalidades")).toBeNull();
  });

  it("o rotulo do botao mantem o valor e diz quantas mensalidades vai abrir", () => {
    render(<Linha itens={[M(), M({ documento: "1002" })]} onAbrirAtendimento={() => {}} />);
    expect(screen.getByTestId("botao-mensalidades").textContent).toMatch(/Mensalidades: R\$ 300,00 \(2\)/);
  });

  it("a quantidade do botao e a quantidade de linhas que abrem (o numero e promessa)", () => {
    render(
      <Linha
        itens={[M(), M({ documento: "1002" }), M({ documento: "1003" })]}
        onAbrirAtendimento={() => {}}
      />
    );
    expect(screen.getByTestId("botao-mensalidades").textContent).toMatch(/\(3\)/);
    fireEvent.click(screen.getByTestId("botao-mensalidades"));
    expect(screen.getAllByTestId("mensalidade-item")).toHaveLength(3);
  });
});

describe("LinhaMensalidades: o que a linha mostra", () => {
  const renderPainel = (itens, total = "R$ 300,00") =>
    render(
      <table>
        <tbody>
          <LinhaMensalidades id="pcm-a1" colSpan={8} nome="Aluna Teste" itens={itens} totalRotulo={total} />
        </tbody>
      </table>
    );

  it("competencia, vencimento, valor e situacao de cada mensalidade", () => {
    renderPainel([M({ valor: 180.5 })]);
    const item = screen.getByTestId("mensalidade-item");
    expect(item.textContent).toMatch(/05\/2026/);
    expect(item.textContent).toMatch(/10\/05\/2026/);
    expect(item.textContent).toMatch(/R\$\s*180,50/);
    expect(item.textContent).toMatch(/Vencida/);
    expect(item.textContent).toMatch(/título 1001/);
  });

  it("a que ainda vai vencer aparece como 'A vencer'", () => {
    renderPainel([M({ vencida: false })]);
    expect(screen.getByTestId("mensalidade-item").textContent).toMatch(/A vencer/);
  });

  it("sem competencia e sem vencimento nao inventa data nem mes", () => {
    renderPainel([M({ competencia: null, vencimento: null })]);
    const item = screen.getByTestId("mensalidade-item");
    expect(item.textContent).toMatch(/—/);
    expect(item.textContent).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("o total exibido e o que a tela passou (nao e somado de novo aqui)", () => {
    renderPainel([M({ valor: 1 }), M({ documento: "1002", valor: 2 })], "R$ 300,00");
    expect(screen.getByTestId("mensalidades-total").textContent).toMatch(/Total: R\$ 300,00/);
  });

  it("ocupa a largura da tabela e se liga ao botao pelo id", () => {
    const { container } = renderPainel([M()]);
    const celula = container.querySelector("td");
    expect(celula.getAttribute("colspan")).toBe("8");
    expect(celula.getAttribute("id")).toBe("pcm-a1");
  });

  it("lista vazia nao mente: diz que nao ha o que detalhar", () => {
    renderPainel([]);
    expect(screen.queryByTestId("mensalidade-item")).toBeNull();
    expect(screen.getByText(/Nenhuma mensalidade em aberto para detalhar/)).toBeTruthy();
  });

  it("o celular recebe regra propria de layout (inline style nao faz media query)", () => {
    const { container } = renderPainel([M()]);
    const css = container.querySelector("style").textContent;
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    // Sem isto a celula do painel herda o display:flex que o celular aplica em
    // toda <td> da tabela e fica sem largura.
    expect(css).toMatch(/\.pc-tabela td\.pcm-celula \{ display: block !important;/);
    expect(css).toMatch(/\.pcm-linha \{ grid-template-columns: 1fr 1fr !important;/);
  });
});
