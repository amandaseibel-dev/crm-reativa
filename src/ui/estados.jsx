// ============================================================
// src/ui/estados.jsx
// Estados padronizados de tela do CRM ReATIVA: Carregando, Erro e Vazio.
// Um só lugar define como o sistema mostra "carregando…", erro e lista vazia,
// em vez de cada tela inventar o seu. Reaproveita tokens de ../ui/cards.
//
// Uso:
//   import { Carregando, Erro, Vazio } from "../ui/estados";
//   if (carregando) return <Carregando />;
//   if (erro) return <Erro texto={erro} onTentar={buscar} />;
//   if (!lista.length) return <Vazio texto="Nenhum aluno na sua fila." />;
//
// Tema: passe tema="escuro" nas telas dark (Fila Operacional, Usuários…).
// ============================================================
import { cartaoErro } from "./cards";

const KEYFRAMES = "@keyframes rv-spin { to { transform: rotate(360deg); } }";

function Spinner({ cor = "#2563eb", tamanho = 22 }) {
  return (
    <>
      <style>{KEYFRAMES}</style>
      <div
        aria-hidden="true"
        style={{
          width: tamanho,
          height: tamanho,
          border: `3px solid ${cor}33`,
          borderTopColor: cor,
          borderRadius: "50%",
          animation: "rv-spin 0.8s linear infinite",
        }}
      />
    </>
  );
}

const wrap = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: "40px 16px",
  textAlign: "center",
};

// Estado de carregamento. Acessível (role=status + aria-live).
export function Carregando({ texto = "Carregando…", tema = "claro" }) {
  const corTexto = tema === "escuro" ? "#94a3b8" : "#64748b";
  const corSpin = tema === "escuro" ? "#60a5fa" : "#2563eb";
  return (
    <div role="status" aria-live="polite" style={{ ...wrap, color: corTexto, fontSize: 14, fontWeight: 600 }}>
      <Spinner cor={corSpin} />
      <span>{texto}</span>
    </div>
  );
}

// Estado de erro, com botão opcional "Tentar de novo". O cartão de erro tem
// fundo próprio (tintado), então fica legível em tema claro e escuro sem ajuste.
export function Erro({ texto = "Não foi possível carregar. Tente de novo.", onTentar }) {
  return (
    <div role="alert" style={wrap}>
      <div style={{ ...cartaoErro, maxWidth: 460, width: "100%", textAlign: "center", fontWeight: 600 }}>
        {String(texto || "Não foi possível carregar. Tente de novo.")}
      </div>
      {onTentar && (
        <button
          type="button"
          onClick={onTentar}
          style={{
            background: "#dc2626",
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "9px 18px",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Tentar de novo
        </button>
      )}
    </div>
  );
}

// Estado vazio (lista sem itens). Neutro, sem alarme.
export function Vazio({ texto = "Nada por aqui.", detalhe, tema = "claro" }) {
  const corTexto = tema === "escuro" ? "#94a3b8" : "#64748b";
  const corDetalhe = tema === "escuro" ? "#64748b" : "#94a3b8";
  return (
    <div style={{ ...wrap, color: corTexto }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{texto}</div>
      {detalhe && <div style={{ fontSize: 13, color: corDetalhe, maxWidth: 420 }}>{detalhe}</div>}
    </div>
  );
}
