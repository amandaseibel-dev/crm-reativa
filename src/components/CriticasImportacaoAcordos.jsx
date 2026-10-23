import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import {
  agruparResumo, rotuloClasse, rotuloMotivo, criticasParaCsv, nomeDoCsv, temCritica,
  semRegistroDeCritica,
} from "../utils/criticasImportacao";

// P3 (23/10/2026) — as criticas da importacao de acordos, na tela de Importacoes.
//
// Existe porque ate aqui nao havia como responder "essa importacao teve
// critica?": `importacoes_acordos` guardava so contadores e as 136 importacoes
// de ACORDOS estavam todas "Concluída".
//
// Nao inventa historico. Importacao anterior a 23/10/2026 aparece com "-" em
// criticas e em arquivo -- ausencia de registro, nao ausencia de problema. Isso
// esta escrito na tela, para ninguem ler "-" como "limpa".

function data(v) {
  if (!v) return "-";
  const d = new Date(v);
  return isNaN(d) ? "-" : d.toLocaleString("pt-BR");
}

function moeda(v) {
  if (v === null || v === undefined || v === "") return "-";
  return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function CriticasImportacaoAcordos() {
  const [lotes, setLotes] = useState(null);
  const [resumo, setResumo] = useState([]);
  const [erro, setErro] = useState("");
  const [aberto, setAberto] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);

  const carregar = useCallback(async () => {
    const [l, r] = await Promise.all([
      supabase.rpc("listar_importacoes_acordos"),
      supabase.rpc("importacao_acordo_critica_resumo", { p_importacao_id: null }),
    ]);
    setErro("");
    if (l.error) { setErro("Erro ao carregar importações de acordos: " + l.error.message); setLotes([]); return; }
    if (r.error) { setErro("Erro ao carregar críticas: " + r.error.message); }
    setLotes(l.data || []);
    setResumo(r.data || []);
  }, []);

  useEffect(() => {
    // mesmo padrao de AcordosPorResponsavel e da Carteira Geral: a carga
    // inicial nasce de um efeito, e `carregar` e useCallback sem dependencia.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
  }, [carregar]);

  async function abrir(id) {
    if (aberto === id) { setAberto(null); setDetalhe(null); return; }
    setAberto(id); setDetalhe(null); setCarregandoDetalhe(true);
    const { data: d, error } = await supabase.rpc("importacao_acordo_critica_listar", { p_importacao_id: id });
    setCarregandoDetalhe(false);
    if (error) { setErro("Erro ao carregar as críticas do lote: " + error.message); return; }
    setDetalhe(d || []);
  }

  function exportar(id, linhas) {
    const csv = criticasParaCsv(linhas);
    // BOM: sem ele o Excel em pt-BR abre acento quebrado.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return csv;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nomeDoCsv(id);
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    return csv;
  }

  const porLote = new Map();
  for (const r of resumo) {
    const atual = porLote.get(r.importacao_id) || [];
    atual.push(r);
    porLote.set(r.importacao_id, atual);
  }

  return (
    <div style={{ marginTop: 40 }} data-testid="criticas-acordos">
      <h2 style={{ marginBottom: 4 }}>Importações de acordos — críticas</h2>
      <p style={{ opacity: 0.75, marginBottom: 16 }}>
        Linha por linha do que foi recusado, duplicado ou deixado de fora em cada
        importação do Relatório de Títulos em Aberto. <strong>Duplicidade</strong> e{" "}
        <strong>Ignorada por regra</strong> não são erro — são o sistema funcionando, e
        ficam aqui para conferência. Só <strong>Rejeitada</strong> pede alguém olhar o arquivo.
      </p>

      <button style={est.botao} onClick={carregar}>Atualizar</button>

      {erro && <p style={{ color: "#f87171" }}>{erro}</p>}
      {lotes == null && <p style={{ opacity: 0.7 }}>Carregando...</p>}
      {lotes && lotes.length === 0 && <p style={{ opacity: 0.7 }}>Nenhuma importação de acordos registrada.</p>}

      {lotes && lotes.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={est.tab}>
            <thead>
              <tr>
                <th style={est.th}>Quando</th>
                <th style={est.th}>Arquivo</th>
                <th style={est.th}>Linhas</th>
                <th style={est.th}>Títulos</th>
                <th style={est.th}>Arquivo preservado</th>
                <th style={est.th}>Críticas</th>
                <th style={est.th}></th>
              </tr>
            </thead>
            <tbody>
              {lotes.map((l) => {
                const criticas = porLote.get(l.importacao_id) || [];
                const antigo = semRegistroDeCritica(l.importado_em);
                return (
                  <tr key={l.importacao_id}>
                    <td style={est.td}>{data(l.importado_em)}</td>
                    <td style={est.td}>{l.arquivo_nome || "-"}</td>
                    <td style={est.td}>{l.linhas_arquivo ?? "-"}</td>
                    <td style={est.td}>{l.titulos_inseridos ?? "-"}</td>
                    <td style={est.td}>
                      {l.arquivo_path
                        ? <span title={l.arquivo_path}>sim</span>
                        : antigo ? <span style={{ opacity: 0.6 }}>-</span> : "não"}
                    </td>
                    <td style={est.td}>
                      {antigo && criticas.length === 0 ? (
                        <span style={{ opacity: 0.6 }} title="Importação anterior a 23/10/2026: não havia registro de crítica. '-' é ausência de registro, não ausência de problema.">
                          sem registro
                        </span>
                      ) : !temCritica(criticas) ? (
                        <span>nenhuma</span>
                      ) : (
                        agruparResumo(criticas).map((c) => (
                          <div key={c.classe}>
                            <strong>{c.total}</strong> {rotuloClasse(c.classe)}
                          </div>
                        ))
                      )}
                    </td>
                    <td style={est.td}>
                      {temCritica(criticas) && (
                        <button style={est.botao} onClick={() => abrir(l.importacao_id)}>
                          {aberto === l.importacao_id ? "Fechar" : "Ver críticas"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {aberto && (
        <div style={est.detalhe} data-testid="detalhe-criticas">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <strong>Críticas do lote {String(aberto).slice(0, 8)}</strong>
            {detalhe && detalhe.length > 0 && (
              <button style={est.botao} onClick={() => exportar(aberto, detalhe)}>
                Exportar CSV
              </button>
            )}
          </div>
          {carregandoDetalhe && <p style={{ opacity: 0.7 }}>Carregando...</p>}
          {detalhe && detalhe.length === 0 && <p style={{ opacity: 0.7 }}>Sem críticas neste lote.</p>}
          {detalhe && detalhe.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={est.tab}>
                <thead>
                  <tr>
                    <th style={est.th}>Natureza</th>
                    <th style={est.th}>Motivo</th>
                    <th style={est.th}>Linha</th>
                    <th style={est.th}>Documento</th>
                    <th style={est.th}>Acordo</th>
                    <th style={est.th}>CPF</th>
                    <th style={est.th}>Aluno</th>
                    <th style={est.th}>Vencimento</th>
                    <th style={est.th}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.map((c) => (
                    <tr key={c.id}>
                      <td style={est.td}>{rotuloClasse(c.classe)}</td>
                      <td style={est.td}>{rotuloMotivo(c.motivo_codigo)}</td>
                      <td style={est.td}>{c.linha_numero ?? "-"}</td>
                      <td style={est.td}>{c.documento || "-"}</td>
                      <td style={est.td}>{c.acordo_ulbra || "-"}</td>
                      <td style={est.td}>{c.cpf_mascarado || "-"}</td>
                      <td style={est.td}>{c.nome || "-"}</td>
                      <td style={est.td}>{c.vencimento || "-"}</td>
                      <td style={est.td}>{moeda(c.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const est = {
  tab: { width: "100%", borderCollapse: "collapse", fontSize: 13.5 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid rgba(148,163,184,0.3)", opacity: 0.8 },
  td: { padding: "8px 10px", borderBottom: "1px solid rgba(148,163,184,0.15)", verticalAlign: "top" },
  botao: { padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.4)",
    background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13 },
  detalhe: { marginTop: 16, padding: 16, borderRadius: 12, border: "1px solid rgba(148,163,184,0.3)" },
};
