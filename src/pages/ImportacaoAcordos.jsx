import { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";

// Importacao do "Relatorio de Titulos em Aberto" (somente acordos).
// Le o arquivo no navegador, mostra previa e grava via RPC importar_acordos,
// que cria alunos faltantes (match por CPF), insere titulos vinculados e
// popula a fila de confirmacao de acordos para a operacao acompanhar.

function soDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

function parseData(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] + "-" + m[2] + "-" + m[1];
  return null;
}

function parseValor(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function moeda(n) {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataHora(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d)) return "-";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ImportacaoAcordos() {
  const [linhas, setLinhas] = useState(null);
  const [resumo, setResumo] = useState(null);
  const [erro, setErro] = useState("");
  const [importando, setImportando] = useState(false);
  const [progresso, setProgresso] = useState("");
  const [resultado, setResultado] = useState(null);
  const [nomeArquivo, setNomeArquivo] = useState("");
  const [historico, setHistorico] = useState(null);

  async function carregarHistorico() {
    const { data, error } = await supabase.rpc("listar_importacoes_acordos");
    if (!error) setHistorico(data || []);
  }

  useEffect(() => { carregarHistorico(); }, []);

  function analisar(e) {
    setErro(""); setResultado(null); setResumo(null); setLinhas(null);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setNomeArquivo(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array", cellDates: true });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sh, { defval: "" });
        const out = [];
        for (const r of rows) {
          const tipo = String(r["Tipo de Boleto"] || "").trim();
          const doc = soDigitos(r["Documento"]);
          if (tipo.toLowerCase() !== "acordo") continue;   // so acordos
          if (!/^\d{6,}$/.test(doc)) continue;               // ignora linha de total
          out.push({
            documento: doc,
            cpf: soDigitos(r["CPF Aluno"]),
            nome: String(r["Titular"] || "").trim(),
            venc: parseData(r["Vcto"]),
            valor: parseValor(r["A Receber Bruto"]),
            unidade: String(r["Estabelecimento"] || "").trim(),
            situacao: String(r["Situação do Aluno"] || "").trim(),
          });
        }
        if (out.length === 0) { setErro("Nenhuma parcela de Acordo encontrada no arquivo. Confira se e o Relatorio de Titulos em Aberto."); return; }
        const cpfs = new Set(), bases = new Set();
        let total = 0;
        for (const o of out) {
          if (o.cpf) cpfs.add(o.cpf);
          bases.add(o.cpf + "|" + o.documento.slice(0, -2));
          total += Number(o.valor) || 0;
        }
        setLinhas(out);
        setResumo({ parcelas: out.length, cpfs: cpfs.size, acordos: bases.size, total });
      } catch (err) {
        setErro("Erro ao ler o arquivo: " + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function importar() {
    if (!linhas) return;
    setImportando(true); setErro(""); setResultado(null);
    const importacaoId = crypto.randomUUID();
    const BATCH = 1200;
    const acc = { alunos_novos: 0, titulos_inseridos: 0, acordos_na_fila: 0, duplicados: 0, pulados: 0, linhasPuladas: 0 };
    try {
      for (let i = 0; i < linhas.length; i += BATCH) {
        const chunk = linhas.slice(i, i + BATCH);
        setProgresso("Gravando " + Math.min(i + BATCH, linhas.length) + " de " + linhas.length + "...");
        const { data, error } = await supabase.rpc("importar_acordos", { p_linhas: chunk, p_importacao_id: importacaoId });
        if (error) throw error;
        acc.alunos_novos += (data && data.alunos_novos) || 0;
        acc.titulos_inseridos += (data && data.titulos_inseridos) || 0;
        acc.acordos_na_fila += (data && data.acordos_na_fila) || 0;
        // Duplicidade nao barra mais a importacao (Amanda, 27/08/2026): o
        // acordo entra marcado e aparece aqui para conferencia.
        acc.duplicados = Math.max(acc.duplicados, (data && data.acordos_duplicados_sinalizados) || 0);
        // Quitados desta semana que a Prime ainda traz com divida: nao entram.
        acc.pulados += (data && data.cpfs_pulados_quitados) || 0;
        acc.linhasPuladas += (data && data.linhas_puladas_quitados) || 0;
      }
      setResultado({ ...acc, importacaoId });
      setProgresso("");
      try {
        await supabase.rpc("registrar_importacao_acordo", {
          p_importacao_id: importacaoId,
          p_arquivo_nome: nomeArquivo || null,
          p_parcelas: resumo ? resumo.parcelas : linhas.length,
          p_acordos: resumo ? resumo.acordos : null,
          p_cpfs: resumo ? resumo.cpfs : null,
          p_alunos_novos: acc.alunos_novos,
          p_titulos_inseridos: acc.titulos_inseridos,
          p_total: resumo ? resumo.total : null,
        });
        carregarHistorico();
      } catch { /* histórico é secundário; não falha o import */ }
    } catch (err) {
      setErro("Erro na importacao: " + (err.message || err));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.titulo}>Importar Acordos</h1>
      <p style={S.sub}>Suba o <strong>Relatorio de Titulos em Aberto</strong> (somente acordos). O sistema vincula cada titulo ao aluno pelo CPF, cria alunos que ainda nao existem e monta a fila de confirmacao para a operacao acompanhar.</p>

      <div style={S.card}>
        <input type="file" accept=".xls,.xlsx" onChange={analisar} style={{ fontSize: 14 }} />
        {nomeArquivo && <span style={S.arq}>{nomeArquivo}</span>}
      </div>

      {erro && <div style={S.erro}>{erro}</div>}

      {resumo && !resultado && (
        <div style={S.card}>
          <h2 style={S.h2}>Previa (nada gravado ainda)</h2>
          <div style={S.grid}>
            <div style={S.box}><div style={S.num}>{resumo.parcelas.toLocaleString("pt-BR")}</div><div style={S.rot}>Parcelas de acordo</div></div>
            <div style={S.box}><div style={S.num}>{resumo.acordos.toLocaleString("pt-BR")}</div><div style={S.rot}>Acordos</div></div>
            <div style={S.box}><div style={S.num}>{resumo.cpfs.toLocaleString("pt-BR")}</div><div style={S.rot}>CPFs (alunos)</div></div>
            <div style={S.box}><div style={S.num}>{moeda(resumo.total)}</div><div style={S.rot}>Total em aberto</div></div>
          </div>
          <button style={S.btn} disabled={importando} onClick={importar}>
            {importando ? (progresso || "Importando...") : "Confirmar e importar"}
          </button>
          <div style={S.obs}>Titulos ja existentes (mesmo documento) sao ignorados automaticamente. A importacao e etiquetada para ser reversivel.</div>
        </div>
      )}

      {resultado && (
        <div style={S.cardOk}>
          <h2 style={S.h2}>Importacao concluida ✅</h2>
          <ul style={S.lista}>
            <li><strong>{resultado.titulos_inseridos.toLocaleString("pt-BR")}</strong> titulos inseridos</li>
            <li><strong>{resultado.alunos_novos.toLocaleString("pt-BR")}</strong> alunos novos criados</li>
            <li><strong>{resultado.acordos_na_fila.toLocaleString("pt-BR")}</strong> acordos na fila de confirmacao</li>
          </ul>
          {resultado.duplicados > 0 && (
            <div style={S.avisoDup}>
              ⚠️ <strong>{resultado.duplicados.toLocaleString("pt-BR")} acordo{resultado.duplicados > 1 ? "s" : ""} entrou duplicado</strong> —
              o aluno já tinha um acordo ATIVO com o mesmo valor e a mesma quantidade de parcelas.
              Nada foi barrado: eles estão na base, marcados para conferência. Abra
              <strong> Acordos duplicados</strong> em Ferramentas para ver o novo e o antigo lado a lado
              e decidir qual cancelar.
            </div>
          )}
          {resultado.pulados > 0 && (
            <div style={S.avisoPulado}>
              🛡️ <strong>{resultado.pulados.toLocaleString("pt-BR")} aluno{resultado.pulados > 1 ? "s" : ""} não {resultado.pulados > 1 ? "foram" : "foi"} importado{resultado.pulados > 1 ? "s" : ""}</strong>{" "}
              ({resultado.linhasPuladas.toLocaleString("pt-BR")} linhas do arquivo) — {resultado.pulados > 1 ? "eles já foram" : "ele já foi"} quitado{resultado.pulados > 1 ? "s" : ""} aqui
              nos últimos 7 dias e {resultado.pulados > 1 ? "têm" : "tem"} acordo. O relatório da Prime ainda mostra a dívida
              porque ela não refletiu a baixa. Importar traria a dívida de volta.
            </div>
          )}
          <div style={S.obs}>Lote: {resultado.importacaoId}</div>
        </div>
      )}

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={S.h2}>Histórico de importações</h2>
          <button style={S.btnGhost} onClick={carregarHistorico}>Atualizar</button>
        </div>
        {historico == null && <div style={S.obs}>Carregando…</div>}
        {historico && historico.length === 0 && <div style={S.obs}>Nenhuma importação registrada ainda.</div>}
        {historico && historico.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={S.tab}>
              <thead>
                <tr>
                  <th style={S.th}>Quando</th>
                  <th style={S.th}>Arquivo</th>
                  <th style={S.th}>Quem</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Acordos</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Títulos</th>
                  <th style={{ ...S.th, textAlign: "right" }}>CPFs</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {historico.map((h, idx) => (
                  <tr key={h.importacao_id} style={idx === 0 ? S.trNovo : undefined}>
                    <td style={S.td}>{dataHora(h.importado_em)}{idx === 0 && <span style={S.tagUlt}>última</span>}</td>
                    <td style={S.td}>{h.arquivo_nome || <span style={{ color: "#94a3b8" }}>— (import antigo)</span>}</td>
                    <td style={S.td}>{h.importado_por || "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.acordos != null ? Number(h.acordos).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.titulos_inseridos != null ? Number(h.titulos_inseridos).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.cpfs != null ? Number(h.cpfs).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.total != null ? moeda(h.total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "6px 0 18px", color: "#64748b", fontSize: 13.5, maxWidth: 720 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 },
  cardOk: { background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 16, padding: 18, marginBottom: 16 },
  arq: { fontSize: 12.5, color: "#64748b" },
  h2: { margin: "0 0 6px", fontFamily: "'Sora', Inter, sans-serif", fontSize: 16, fontWeight: 800, color: "#0d1321" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  box: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px", textAlign: "center" },
  num: { fontSize: 22, fontWeight: 800, color: "#0d1321", fontFamily: "'Sora', Inter, sans-serif" },
  rot: { fontSize: 12, color: "#8a93a3", fontWeight: 600, marginTop: 3 },
  btn: { alignSelf: "flex-start", background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontWeight: 800, fontSize: 14, cursor: "pointer" },
  obs: { fontSize: 12, color: "#8a93a3" },
  avisoPulado: {
    background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, margin: "10px 0",
  },
  avisoDup: {
    background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, margin: "10px 0",
  },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13.5, fontWeight: 600 },
  lista: { margin: "6px 0 8px", paddingLeft: 18, fontSize: 14, color: "#166534", lineHeight: 1.7 },
  btnGhost: { background: "#fff", color: "#1e40af", border: "1px solid #c7d2fe", borderRadius: 9, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  tab: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", color: "#64748b", fontWeight: 700, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.03em", padding: "8px 10px", borderBottom: "1px solid #e6eaf0", whiteSpace: "nowrap" },
  td: { padding: "9px 10px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", whiteSpace: "nowrap" },
  trNovo: { background: "#f0f7ff" },
  tagUlt: { marginLeft: 8, background: "#1e40af", color: "#fff", borderRadius: 6, padding: "1px 7px", fontSize: 10.5, fontWeight: 800, verticalAlign: "middle" },
};
