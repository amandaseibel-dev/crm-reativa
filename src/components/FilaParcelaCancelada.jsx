import { useCallback, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { lerFilaParcelaCancelada } from "../services/filaParcelaCanceladaService";
import {
  CLASSIFICACOES, ROTULO_CLASSIFICACAO, EXPLICACAO_CLASSIFICACAO, ROTULO_ESCOPO,
  filtrarFila, totaisDaFila, textoDoSelo,
} from "../utils/filaParcelaCancelada";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

const selo = {
  display: "inline-block", marginLeft: 6, padding: "1px 6px", borderRadius: 4,
  fontSize: 11, fontWeight: 600, background: "var(--rv-vermelho-fundo, #fde8e8)",
  color: "var(--rv-vermelho-texto, #8a1c1c)", border: "1px solid var(--rv-vermelho-borda, #f0b4b4)",
};
const seloNeutro = { ...selo, background: "var(--rv-cinza-fundo, #eee)", color: "inherit", borderColor: "#ccc" };

// Fila de excecoes SOMENTE LEITURA. Nenhum botao aqui baixa, quita, cancela ou muda
// status: a tela existe para a gestao DECIDIR, e a decisao sai daqui para o fluxo
// proprio, com autorizacao. O aviso no topo diz isso em voz alta, de proposito.
export default function FilaParcelaCancelada() {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [linhas, setLinhas] = useState([]);
  const [erro, setErro] = useState("");
  const [escopo, setEscopo] = useState("PARCELA_CANCELADA");
  const [classificacao, setClassificacao] = useState(null);
  const [somenteSemBaixa, setSomenteSemBaixa] = useState(false);
  const [somenteComCopiaAtiva, setSomenteComCopiaAtiva] = useState(false);
  const [somenteCobrancaPotencial, setSomenteCobrancaPotencial] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    const { linhas: lidas, erro: e } = await lerFilaParcelaCancelada(supabase);
    if (e === "SEM_PERMISSAO_DE_GESTAO") setErro("Esta fila é restrita à gestão.");
    else if (e) setErro("Não foi possível ler a fila por inteiro. Nada é exibido pela metade.");
    setLinhas(lidas);
    setCarregando(false);
  }, []);

  function alternar() {
    if (aberto) { setAberto(false); return; }
    setAberto(true);
    if (!linhas.length && !erro) carregar();
  }

  const visiveis = useMemo(
    () => filtrarFila(linhas, { escopo, classificacao, somenteSemBaixa, somenteComCopiaAtiva, somenteCobrancaPotencial }),
    [linhas, escopo, classificacao, somenteSemBaixa, somenteComCopiaAtiva, somenteCobrancaPotencial],
  );
  const totais = useMemo(() => totaisDaFila(visiveis), [visiveis]);
  const escopos = useMemo(
    () => [...new Set(linhas.map((l) => l.escopo))].sort(), [linhas],
  );

  return (
    <section style={{ margin: "10px 0" }}>
      <button type="button" onClick={alternar} disabled={carregando}>
        {carregando ? "Lendo…" : aberto ? "▾ Ocultar pagamentos em parcela cancelada"
          : "▸ Pagamentos em parcela cancelada"}
      </button>

      {aberto ? (
        <div style={{ marginTop: 8, border: "1px solid var(--rv-borda, #ddd)", borderRadius: 6, padding: 10 }}>
          <p role="note" style={{ margin: "0 0 8px", fontWeight: 600 }}>
            Somente leitura. Nenhuma ação desta tela baixa, quita, cancela ou altera status.
          </p>

          {erro ? <p role="alert">{erro}</p> : null}

          {!erro ? (
            <>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                <label>
                  Escopo{" "}
                  <select value={escopo} onChange={(e) => setEscopo(e.target.value)}>
                    <option value="PARCELA_CANCELADA">{ROTULO_ESCOPO.PARCELA_CANCELADA}</option>
                    {escopos.filter((x) => x !== "PARCELA_CANCELADA").map((x) => (
                      <option key={x} value={x}>{ROTULO_ESCOPO[x] ?? x}</option>
                    ))}
                    <option value="TODOS">Todos</option>
                  </select>
                </label>
                <label>
                  Risco{" "}
                  <select value={classificacao ?? ""} onChange={(e) => setClassificacao(e.target.value || null)}>
                    <option value="">Todos</option>
                    {CLASSIFICACOES.map((c) => (
                      <option key={c} value={c}>{ROTULO_CLASSIFICACAO[c]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <input type="checkbox" checked={somenteSemBaixa}
                    onChange={(e) => setSomenteSemBaixa(e.target.checked)} /> sem baixa
                </label>
                <label>
                  <input type="checkbox" checked={somenteComCopiaAtiva}
                    onChange={(e) => setSomenteComCopiaAtiva(e.target.checked)} /> acordo ativo duplicado
                </label>
                <label>
                  <input type="checkbox" checked={somenteCobrancaPotencial}
                    onChange={(e) => setSomenteCobrancaPotencial(e.target.checked)} /> cobrança potencialmente indevida
                </label>
                <button type="button" onClick={carregar} disabled={carregando}>Atualizar</button>
              </div>

              <p style={{ fontSize: 13, margin: "8px 0" }}>
                <strong>{totais.pagamentos}</strong> pagamento{totais.pagamentos === 1 ? "" : "s"} ·{" "}
                <strong>{totais.alunos}</strong> aluno{totais.alunos === 1 ? "" : "s"} ·{" "}
                {moeda(totais.valor)} · sem baixa {moeda(totais.valor_sem_baixa)} ·{" "}
                cobrança potencialmente indevida <strong>{totais.cobranca_potencial}</strong>
                {totais.sem_identidade
                  ? <> · <span style={selo}>{totais.sem_identidade} sem prova de identidade</span></>
                  : null}
              </p>

              {classificacao ? (
                <p style={{ fontSize: 12, margin: "0 0 8px" }}>{EXPLICACAO_CLASSIFICACAO[classificacao]}</p>
              ) : null}

              {!visiveis.length ? <p>Nenhuma linha neste filtro.</p> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Pessoa</th>
                        <th style={{ textAlign: "left" }}>Pago</th>
                        <th style={{ textAlign: "right" }}>Valor</th>
                        <th style={{ textAlign: "left" }}>Boleto</th>
                        <th style={{ textAlign: "left" }}>Acordo</th>
                        <th style={{ textAlign: "right" }}>Parcela</th>
                        <th style={{ textAlign: "right" }}>Aberto hoje</th>
                        <th style={{ textAlign: "left" }}>Risco</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiveis.map((l) => (
                        <tr key={l.pagamento_id} style={{ borderTop: "1px solid var(--rv-borda, #eee)" }}>
                          <td>
                            {l.aluno_nome || "(sem nome)"}
                            <div style={{ fontSize: 11 }}>
                              matrícula Prime {l.matricula_prime || "—"}
                              {!l.identidade_comprovada
                                ? <span style={selo}>sem prova de identidade</span> : null}
                            </div>
                          </td>
                          <td>{curta(l.data_pagamento)}</td>
                          <td style={{ textAlign: "right" }}>{moeda(l.valor_pago)}</td>
                          <td>{l.boleto_pago}</td>
                          <td>
                            {l.acordo_numero_ulbra || "(sem nº)"}
                            {/* Item 3/4 do escopo: o cancelamento NUNCA aparece implicito. */}
                            {(l.selos || []).map((s) => (
                              <span key={s} style={selo}>{textoDoSelo(s)}</span>
                            ))}
                            {Number(l.copia_ativa_mesmo_numero) > 0 ? (
                              <span style={selo} title="Existe acordo ATIVO com o mesmo numero_ulbra — duplicidade de importação, não substituição negociada.">
                                cópia ativa do mesmo nº
                              </span>
                            ) : null}
                            {Number(l.substituto_na_janela) > 0 ? (
                              <span style={seloNeutro} title="Acordo ATIVO criado na janela de ±1h do cancelamento — substituição deliberada.">
                                substituto na janela
                              </span>
                            ) : null}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {moeda(l.parcela_valor)}
                            <div style={{ fontSize: 11 }}>
                              {l.tem_baixa_equivalente
                                ? (l.baixa_sem_vinculo ? "baixa sem vínculo" : "com baixa")
                                : <strong>sem baixa</strong>}
                            </div>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {moeda(l.saldo_acordo_aberto)}
                            {Number(l.parcelas_abertas_mesmo_valor) > 0 ? (
                              <div style={{ fontSize: 11 }}>
                                {l.parcelas_abertas_mesmo_valor} parcela(s) com o valor exato
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {ROTULO_CLASSIFICACAO[l.classificacao] ?? l.classificacao}
                            <div style={{ fontSize: 11 }}>{l.grupo}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
