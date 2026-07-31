import { useState } from "react";

// Tour de novidades: aparece 1x por versão (localStorage). Some ao fechar.
// Para lançar novas novidades no futuro, troque VERSAO e atualize a lista.
const VERSAO = "2026-07-31";

const NOVIDADES = [
  {
    icone: "🎯",
    titulo: "Tabule já na tela inicial da ficha",
    texto: "A aba “Tabulação” saiu — agora você tabula direto na tela “Resumo e tabulação”, sem trocar de aba.",
  },
  {
    icone: "🏷️",
    titulo: "Selos coloridos no topo da ficha",
    texto: "De relance: situação financeira, status, criticidade e responsável do aluno.",
  },
  {
    icone: "🧹",
    titulo: "Tabulação mais limpa e compacta",
    texto: "Campos menores e menos espaço — mais informação na tela, menos rolagem.",
  },
  {
    icone: "📈",
    titulo: "Nova tela “Efetividade”",
    texto: "No menu Operação: veja a sua própria performance (cobertura, acordos, recuperado, conversão) por período.",
  },
  {
    icone: "🌙",
    titulo: "Tema claro ou escuro",
    texto: "Botão na barra lateral (acima de “Sair”) — escolha do seu jeito, fica salvo.",
  },
];

export default function TourNovidades({ usuario }) {
  const perfil = usuario?.perfil?.perfil;
  const chave = `rv_tour_novidades_${VERSAO}`;
  const [aberto, setAberto] = useState(() => {
    if (!usuario) return false;
    try {
      return window.localStorage.getItem(chave) !== "1";
    } catch (e) {
      return true;
    }
  });

  if (!usuario || !aberto) return null;

  function fechar() {
    try {
      window.localStorage.setItem(chave, "1");
    } catch (e) {
      /* ignore */
    }
    setAberto(false);
  }

  return (
    <div style={S.overlay} onClick={fechar}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.cabecalho}>
          <div style={S.tag}>✨ Novidades</div>
          <h2 style={S.titulo}>O que mudou pra você</h2>
          <p style={S.sub}>Umas melhorias rapidinhas pra facilitar o dia a dia:</p>
        </div>

        <div style={S.lista}>
          {NOVIDADES.map((n, i) => (
            <div key={i} style={S.item}>
              <div style={S.icone}>{n.icone}</div>
              <div>
                <div style={S.itemTitulo}>{n.titulo}</div>
                <div style={S.itemTexto}>{n.texto}</div>
              </div>
            </div>
          ))}
        </div>

        <button type="button" style={S.botao} onClick={fechar}>
          Entendi, vamos lá 🚀
        </button>
        {perfil !== "operador" && (
          <p style={S.rodape}>
            (Gestão tem mais novidades na aba ⚖️ Calibragem e no 📈 Efetividade da equipe.)
          </p>
        )}
      </div>
    </div>
  );
}

const FONTE = "'Sora','Inter',system-ui,sans-serif";
const S = {
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONTE },
  modal: { background: "#fff", color: "#0f172a", borderRadius: 18, width: "min(480px, 100%)", maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 70px rgba(0,0,0,0.4)", padding: 24 },
  cabecalho: { marginBottom: 16 },
  tag: { display: "inline-block", fontSize: 12, fontWeight: 800, color: "#7c3aed", background: "#f3e8ff", borderRadius: 999, padding: "4px 12px", marginBottom: 10 },
  titulo: { fontSize: 22, fontWeight: 800, margin: "0 0 4px" },
  sub: { fontSize: 14, color: "#64748b", margin: 0 },
  lista: { display: "flex", flexDirection: "column", gap: 12, margin: "18px 0" },
  item: { display: "flex", gap: 12, alignItems: "flex-start" },
  icone: { fontSize: 22, lineHeight: 1, width: 30, textAlign: "center", flexShrink: 0 },
  itemTitulo: { fontSize: 14.5, fontWeight: 800, color: "#0f172a" },
  itemTexto: { fontSize: 13, color: "#475569", lineHeight: 1.45, marginTop: 2 },
  botao: { width: "100%", padding: "12px", borderRadius: 12, border: "none", background: "#2563eb", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" },
  rodape: { fontSize: 12, color: "#94a3b8", textAlign: "center", margin: "10px 0 0" },
};
