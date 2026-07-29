import { useState } from "react";
import { podeVerRelatorios, EQUIPE_9, OPERADORES_POR_EMAIL } from "../../utils/operadores";
import {
  exportarIndividual, exportarGeralRH, exportarGeralPagamentos,
  exportarTodosIndividuais, exportarPacoteCompleto,
} from "../../utils/relatoriosProjecaoExcel";

// Central de Relatórios — botão no canto superior direito, EXCLUSIVO de
// Amanda gestora e Fernanda (mesma allowlist do backend). Gera .xlsx/.zip
// a partir do snapshot já carregado (nunca consulta public.pagamentos).
export default function CentralRelatorios({ email, mes, filialPayload, operadoresPayloadPorEmail }) {
  const [aberto, setAberto] = useState(false);
  const [ocupado, setOcupado] = useState("");
  const [erro, setErro] = useState("");
  const [operadorSel, setOperadorSel] = useState("");

  if (!podeVerRelatorios(email)) return null; // dupla trava (backend também barra)

  async function rodar(chave, fn) {
    setErro(""); setOcupado(chave);
    try { await fn(); }
    catch (e) { setErro(e?.message || "Falha ao gerar o relatório."); }
    finally { setOcupado(""); }
  }

  const opcoes = [
    { chave: "geral_rh", rotulo: "📊 Relatório Geral para o RH", fn: () => exportarGeralRH(mes, filialPayload, operadoresPayloadPorEmail) },
    { chave: "geral_pag", rotulo: "🧾 Relatório Geral de Pagamentos", fn: () => exportarGeralPagamentos(mes) },
    { chave: "todos", rotulo: "🗂️ Todos os 9 Relatórios Individuais (ZIP)", fn: () => exportarTodosIndividuais(mes, operadoresPayloadPorEmail) },
    { chave: "pacote", rotulo: "📦 Pacote Completo para o RH (ZIP)", fn: () => exportarPacoteCompleto(mes, filialPayload, operadoresPayloadPorEmail) },
  ];

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setAberto((v) => !v)} style={estilos.botao} title="Central de Relatórios (Amanda/Fernanda)">
        📁 Relatórios ▾
      </button>
      {aberto && (
        <>
          <div style={estilos.backdrop} onClick={() => setAberto(false)} />
          <div style={estilos.menu}>
            <div style={estilos.titulo}>Central de Relatórios · {mes}</div>

            <div style={estilos.blocoIndividual}>
              <div style={estilos.subtitulo}>Relatório Individual por Operador</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select value={operadorSel} onChange={(e) => setOperadorSel(e.target.value)} style={estilos.select}>
                  <option value="">Selecione um dos 9…</option>
                  {EQUIPE_9.map((o) => (
                    <option key={o.email} value={o.email}>{o.nome}</option>
                  ))}
                </select>
                <button
                  disabled={!operadorSel || ocupado === "individual"}
                  onClick={() => rodar("individual", () => exportarIndividual(mes, operadorSel, operadoresPayloadPorEmail[operadorSel]))}
                  style={{ ...estilos.acao, opacity: !operadorSel ? 0.5 : 1 }}
                >
                  {ocupado === "individual" ? "Gerando…" : "Gerar Excel"}
                </button>
              </div>
            </div>

            {opcoes.map((op) => (
              <button
                key={op.chave}
                disabled={ocupado === op.chave}
                onClick={() => rodar(op.chave, op.fn)}
                style={estilos.item}
              >
                {ocupado === op.chave ? "Gerando…" : op.rotulo}
              </button>
            ))}

            {erro && <div style={estilos.erro}>{erro}</div>}
            <div style={estilos.rodape}>
              Arquivos gerados a partir do snapshot ({mes}); mesma atualização. Sem CPF/telefone.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const estilos = {
  botao: { padding: "8px 16px", borderRadius: 10, border: "1px solid #1e40af", background: "#1e40af", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  backdrop: { position: "fixed", inset: 0, zIndex: 40 },
  menu: { position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 50, width: 340, background: "#fff", border: "1px solid #e3e7ee", borderRadius: 12, boxShadow: "0 14px 40px rgba(15,23,42,0.18)", padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  titulo: { fontSize: 13, fontWeight: 800, color: "#0d1321" },
  subtitulo: { fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 },
  blocoIndividual: { padding: 10, border: "1px solid #edf0f5", borderRadius: 10, background: "#f8fafc" },
  select: { flex: 1, minWidth: 150, padding: "7px 10px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 12.5 },
  acao: { padding: "7px 12px", borderRadius: 8, border: "none", background: "#0f9d6b", color: "#fff", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  item: { textAlign: "left", padding: "10px 12px", borderRadius: 8, border: "1px solid #edf0f5", background: "#fff", color: "#0d1321", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  erro: { color: "#b91c1c", fontSize: 12.5 },
  rodape: { fontSize: 11, color: "#94a3b8", marginTop: 2 },
};
