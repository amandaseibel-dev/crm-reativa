// ============================================================
// src/ui/cards.js
// Padrão único de cartões/superfícies do CRM ReATIVA.
// Objetivo: um só lugar define a aparência dos cards. Cada tela
// importa daqui em vez de redefinir seus próprios objetos inline.
//
// Como usar (migração de baixo risco): mantenha o nome local e
// aponte para o token compartilhado —
//     import { cartao, superficie } from "../ui/cards";
//     const cardInfo = cartao;               // 1:1
//     const cardMov  = { ...cartao, borderLeft: "4px solid #2563eb" }; // com extra
//
// Há dois temas: CLARO (Ficha do Aluno, Confirmações…) e
// ESCURO (Fila Operacional, Usuários…). Não misture: use os
// tokens "…Escuro" nas telas dark.
// ============================================================

// ---- Tokens base ----
export const raio = { sm: "9px", md: "12px", lg: "14px", xl: "16px" };

export const sombra = {
  suave: "0 1px 3px rgba(15,23,42,0.05)",
  leve: "0 1px 2px rgba(15,23,42,0.04)",
  modal: "0 20px 60px rgba(0,0,0,0.35)",
};

export const cor = {
  // claro
  superficieClara: "#ffffff",
  fundoCartaoClaro: "#f8fafc",
  bordaClaraExterna: "#eef2f6",
  bordaClaraInterna: "#e6eaf0",
  textoClaro: "#475569",
  rotulo: "#94a3b8",
  // escuro
  superficieEscura: "#111827",
  fundoCartaoEscuroFundo: "#020617",
  bordaEscura: "#374151",
  bordaEscuraSuave: "#1f2937",
  textoEscuro: "#e5e7eb",
};

// ============================================================
// TEMA CLARO
// ============================================================

// Container branco de página/seção (o "box" externo).
export const superficie = {
  background: cor.superficieClara,
  border: `1px solid ${cor.bordaClaraExterna}`,
  borderRadius: raio.lg,
  padding: "16px",
  marginBottom: "16px",
  boxShadow: sombra.suave,
};

// Cartão de conteúdo compacto (padrão do CRM).
export const cartao = {
  background: cor.fundoCartaoClaro,
  border: `1px solid ${cor.bordaClaraInterna}`,
  borderRadius: raio.md,
  padding: "9px 12px",
  color: cor.textoClaro,
  fontSize: 13,
  lineHeight: 1.35,
};

// Cartão interno menor (dentro de outro card/box).
export const cartaoInterno = {
  ...cartao,
  borderRadius: raio.sm,
  padding: "8px 11px",
  marginBottom: "10px",
};

// Rótulo executivo (título curto em maiúsculas sobre o valor).
export const cartaoTitulo = {
  display: "block",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: cor.rotulo,
  marginBottom: 1,
};

// ---- Faixa horizontal de mini-itens (secundários) ----
export const faixaMini = {
  display: "flex",
  flexWrap: "wrap",
  gap: 0,
  marginBottom: "12px",
  background: cor.fundoCartaoClaro,
  border: `1px solid ${cor.bordaClaraInterna}`,
  borderRadius: raio.sm,
  padding: "8px 4px",
};
export const itemMini = {
  flex: "1 1 120px",
  minWidth: 0,
  padding: "2px 12px",
  borderLeft: `1px solid ${cor.bordaClaraInterna}`,
};
export const valorMini = {
  fontSize: 12.5,
  color: "#334155",
  lineHeight: 1.3,
};

// ---- Cartões de estado (tema claro, fundos tintados) ----
// Preservam texto FORTE e em negrito (a cor comunica o estado).
export const cartaoSucesso = {
  ...cartao,
  background: "#f0fdf4",
  border: "1px solid #86efac",
  color: "#166534",
  fontWeight: 700,
  padding: "12px 14px",
};
export const cartaoAviso = {
  ...cartao,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#92400e",
  fontWeight: 700,
  padding: "12px 14px",
};
export const cartaoErro = {
  ...cartao,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  fontWeight: 700,
  padding: "12px 14px",
};

// Cartão de informação tintado (fundo suave + borda + texto na mesma família de cor).
// Ex.: cartaoInfo("#eff6ff", "#bfdbfe", "#1e40af") para um painel azul.
export const cartaoInfo = (bg, corBorda, texto) => ({
  ...cartao,
  background: bg,
  border: `1px solid ${corBorda}`,
  color: texto,
  padding: "12px 14px",
});

// Cartão com borda de acento colorido sobre fundo branco (ex.: laranja p/ ADM).
export const cartaoAcento = (corBorda) => ({
  ...cartao,
  background: cor.superficieClara,
  border: `1px solid ${corBorda}`,
  padding: "12px 14px",
});

// Modal/painel grande claro.
export const modalBox = {
  background: cor.superficieClara,
  borderRadius: raio.xl,
  padding: "20px",
  boxShadow: sombra.modal,
};

// ============================================================
// TEMA ESCURO
// ============================================================

// Container de página/seção escuro.
export const superficieEscura = {
  background: cor.superficieEscura,
  border: `1px solid ${cor.bordaEscuraSuave}`,
  borderRadius: raio.lg,
  padding: "16px",
  marginBottom: "20px",
};

// Cartão de conteúdo escuro.
export const cartaoEscuro = {
  background: cor.superficieEscura,
  border: `1px solid ${cor.bordaEscura}`,
  borderRadius: raio.md,
  padding: "12px",
  color: cor.textoEscuro,
};

// Cartão interno escuro (fundo mais fundo).
export const cartaoInternoEscuro = {
  ...cartaoEscuro,
  background: cor.fundoCartaoEscuroFundo,
};

// Cartão com borda de acento no tema escuro.
export const cartaoAcentoEscuro = (corBorda) => ({
  ...cartaoEscuro,
  border: `1px solid ${corBorda}`,
});

// Modal/painel grande escuro.
export const modalBoxEscuro = {
  background: cor.superficieEscura,
  border: `1px solid ${cor.bordaEscura}`,
  borderRadius: raio.xl,
  padding: "24px",
  boxShadow: sombra.modal,
};
