/* eslint-disable react-refresh/only-export-components -- harness de preview:
   nao ha Fast Refresh a preservar aqui, e um arquivo de entrada. */
import { createRoot } from "react-dom/client";
import { Fragment, useEffect, useState } from "react";
import { BotaoMensalidades, LinhaMensalidades } from "/src/components/MensalidadesDoAluno.jsx";
import FaixaPrioridadeCarteira from "/src/components/FaixaPrioridadeCarteira.jsx";
import { contarPorPrioridade, faixaPrioridade } from "/src/utils/carteiraFila.js";

// Revisao visual do conserto da caixinha "Mensalidades" na Minha Carteira
// (relato da operacao, 22/10/2026: "nao abre ao clicar").
//
// Os COMPONENTES sao os reais -- `BotaoMensalidades` e `LinhaMensalidades`, os
// mesmos que o PainelCarteira usa. O que esta dublado aqui e so o entorno: a
// tabela, as colunas e o clique da linha que, na tela de verdade, abre o
// atendimento. A tela inteira nao entra: ela carrega carteira, acordos,
// titulos, agenda e indicadores, e montar tudo isso aqui esconderia o que se
// quer olhar.
//
// Nenhum dado vem de producao: os alunos e as mensalidades abaixo sao
// inventados.

// Copia das regras de celular da tabela da carteira (CSS_RESPONSIVO, em
// PainelCarteira.jsx). Vem para ca porque media query responde ao VIEWPORT, nao
// ao container: sem elas, estreitar a janela aqui nao reproduziria o card que o
// operador ve no telefone. Se as de la mudarem, estas tambem precisam mudar.
const CSS_CARTEIRA = `
  .pc-tabela { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
  .pc-tabela th { text-align: left; padding: 11px 12px; color: #64748b; font-size: 10.5px; font-weight: 700;
                  text-transform: uppercase; letter-spacing: 0.05em; background: #f1f5f9;
                  border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
  .pc-tabela td { padding: 14px; color: #0f172a; vertical-align: middle; }
  .pc-tabela td.valor { padding: 11px 10px; text-align: right; white-space: nowrap; }
  .pc-tabela tbody tr { cursor: pointer; border-bottom: 1px solid #eef2f6; }
  @media (max-width: 640px) {
    .pc-tabela thead { display: none; }
    .pc-tabela, .pc-tabela tbody, .pc-tabela tr, .pc-tabela td { display: block; width: 100%; }
    .pc-tabela tr { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; margin-bottom: 10px; padding: 12px 14px; }
    .pc-tabela td { padding: 6px 0 !important; border: none !important; text-align: left !important;
                    display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .pc-tabela td[data-label]::before {
      content: attr(data-label); font-size: 10.5px; font-weight: 700; color: #64748b;
      text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; padding-top: 2px;
    }
    .pc-tabela td[data-label="Valor aberto"] > div { align-items: flex-end; text-align: right; }
  }
`;

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const mens = (documento, competencia, vencimento, valor, vencida) => ({
  documento, competencia, vencimento, valor, vencida,
});

// Tres casos que a tela precisa aguentar: a carteira cheia (varias
// mensalidades, vencidas e a vencer), a mensalidade unica e o aluno que so tem
// acordo -- este ultimo nao pode virar botao, porque nao ha o que abrir.
const ALUNOS = [
  {
    id: "a1",
    nome: "Ana Clara Ribeiro",
    cpf: "123.456.789-00",
    nivel_criticidade: "PERDENDO",
    data_ultimo_acionamento: "2026-10-02",
    itens: [
      mens("70101", "02/2026", "2026-02-10", 892.4, true),
      mens("70102", "03/2026", "2026-03-10", 892.4, true),
      mens("70103", "04/2026", "2026-04-10", 892.4, true),
      mens("70104", "05/2026", "2026-05-10", 892.4, true),
      mens("70105", "11/2026", "2026-11-10", 905.17, false),
      mens("70106", null, null, 148.9, false),
    ],
    acordos: 0,
  },
  {
    id: "a2",
    nome: "Bruno Henrique Alves",
    cpf: "987.654.321-00",
    nivel_criticidade: "URGENTE",
    data_ultimo_acionamento: "2026-10-20",
    itens: [mens("71550", "09/2026", "2026-09-05", 1240, true)],
    acordos: 3180.5,
  },
  {
    id: "a3",
    nome: "Carla Souza Lima (so acordo)",
    cpf: "456.789.123-00",
    nivel_criticidade: "ATENCAO",
    data_ultimo_acionamento: "2026-10-21",
    itens: [],
    acordos: 5400,
  },
];

const somar = (itens) => itens.reduce((t, m) => t + m.valor, 0);

function App() {
  const [abertas, setAbertas] = useState(new Set());
  const [atendimento, setAtendimento] = useState(null);
  const [faixa, setFaixa] = useState("TODAS");
  const AGORA = Date.parse("2026-10-22T12:00:00Z");
  const visiveis = faixa === "TODAS" ? ALUNOS : ALUNOS.filter((a) => faixaPrioridade(a, AGORA) === faixa);
  const contagens = contarPorPrioridade(ALUNOS, AGORA);
  useEffect(() => { document.title = "Minha Carteira — mensalidades que abrem"; }, []);

  const alternar = (id) =>
    setAbertas((atual) => {
      const p = new Set(atual);
      if (p.has(id)) p.delete(id); else p.add(id);
      return p;
    });

  return (
    <div className="pc-root" style={{ padding: 20, background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui" }}>
      <style>{CSS_CARTEIRA}</style>
      <h1 style={{ font: "800 18px system-ui", margin: "0 0 4px" }}>
        Minha Carteira — a caixinha “Mensalidades” abrindo
      </h1>
      <p style={{ font: "400 13px system-ui", color: "#475569", margin: "0 0 10px", maxWidth: 760 }}>
        Clique em <b>Mensalidades: R$ … (n)</b> para abrir o detalhamento. Clique em{" "}
        <b>qualquer outro ponto da linha</b> para ver que o atendimento continua abrindo como
        sempre — a caixa nao rouba esse clique. Estreite a janela para menos de 640px para ver o
        celular.
      </p>

      <div
        style={{
          font: "700 13px system-ui", margin: "0 0 14px", padding: "8px 12px", borderRadius: 10,
          background: atendimento ? "#dcfce7" : "#f1f5f9",
          color: atendimento ? "#166534" : "#64748b",
          border: `1px solid ${atendimento ? "#86efac" : "#e2e8f0"}`,
        }}
        data-testid="aviso-atendimento"
      >
        {atendimento ? `Atendimento aberto: ${atendimento}` : "Nenhum atendimento aberto ainda."}
      </div>

      <FaixaPrioridadeCarteira
        contagens={contagens}
        selecionada={faixa}
        onSelecionar={setFaixa}
        cores={{
          PERDENDO: { bg: "rgba(190,18,60,0.28)", cor: "#7f1d1d" },
          CRITICO: { bg: "rgba(220,38,38,0.20)", cor: "#991b1b" },
          URGENTE: { bg: "rgba(234,88,12,0.20)", cor: "#9a3412" },
          ATENCAO: { bg: "rgba(245,158,11,0.18)", cor: "#92400e" },
          NOVO: { bg: "rgba(30,58,138,0.18)", cor: "#1e3a8a" },
          NORMAL: { bg: "rgba(100,116,139,0.16)", cor: "#334155" },
        }}
      />

      <div style={{ overflowX: "auto", borderRadius: 12, background: "#fff", border: "1px solid #e2e8f0" }}>
        <table className="pc-tabela">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF</th>
              <th>Situacao</th>
              <th>Ult. contato</th>
              <th>Prox. contato</th>
              <th style={{ textAlign: "right" }}>Valor aberto</th>
              <th>Status</th>
              <th>Acao rapida</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((a) => {
              const total = somar(a.itens);
              const aberto = abertas.has(a.id);
              return (
                <Fragment key={a.id}>
                  <tr onClick={() => setAtendimento(a.nome)}>
                    <td data-label="Nome"><b>{a.nome}</b></td>
                    <td data-label="CPF">{a.cpf}</td>
                    <td data-label="Situação">Em cobranca</td>
                    <td data-label="Últ. contato">20/10/2026</td>
                    <td data-label="Próx. contato">24/10/2026</td>
                    <td className="valor" data-label="Valor aberto">
                      <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 13.5 }}>
                          Em aberto: {moeda(total + a.acordos)}
                        </div>
                        {a.itens.length > 0 ? (
                          <div style={{ fontSize: 11, color: "#64748b" }}>
                            <BotaoMensalidades
                              qtd={a.itens.length}
                              valorRotulo={moeda(total)}
                              aberto={aberto}
                              idPainel={`pcm-${a.id}`}
                              onAlternar={() => alternar(a.id)}
                            />
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: "#64748b" }}>Mensalidades: {moeda(total)}</div>
                        )}
                        <div style={{ fontSize: 11, color: "#64748b" }}>Acordos: {moeda(a.acordos)}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>Responsavel: Amanda</div>
                      </div>
                    </td>
                    <td data-label="Status">No prazo</td>
                    <td data-label="Ação rápida">
                      <button type="button" style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 11.5, fontWeight: 700 }}>
                        ✅ Mensagem enviada
                      </button>
                    </td>
                  </tr>
                  {aberto && (
                    <LinhaMensalidades
                      id={`pcm-${a.id}`}
                      colSpan={8}
                      nome={a.nome}
                      itens={a.itens}
                      totalRotulo={moeda(total)}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

createRoot(document.getElementById("raiz")).render(<App />);
