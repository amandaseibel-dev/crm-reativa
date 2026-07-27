import { MENSAGEM_CONTENCAO } from "../config/modoContencao";

// Aviso padrão exibido no lugar de indicadores/dashboards enquanto o modo de
// contenção está ativo. NÃO é erro, NÃO tem loading, NÃO derruba a sessão.
export default function AvisoContencao() {
  return (
    <div
      role="status"
      style={{
        margin: "12px 0",
        padding: "14px 16px",
        borderRadius: 10,
        background: "#fff7ed",
        border: "1px solid #fdba74",
        color: "#9a3412",
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      ⏸️ {MENSAGEM_CONTENCAO}
    </div>
  );
}
