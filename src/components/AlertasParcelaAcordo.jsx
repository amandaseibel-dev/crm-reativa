// Card "Parcela de acordo proxima do vencimento" (Minha Carteira). Puro: recebe os alertas e o callback de abrir a ficha.
// Fonte unica do D-2 (RPC acordo_alertas_do_operador); substitui o card antigo de lembrete por data_retorno.
import { ordenarAlertas, chaveAlerta, descricaoAlerta, rotuloDiasRestantes, formatarDataBR, formatarValorBRL } from "../utils/alertasParcela";

const S = {
  painel: { border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "12px 14px", margin: "0 0 14px", background: "var(--rv-card)" },
  titulo: { margin: "0 0 8px", fontSize: 14.5, fontWeight: 800, color: "var(--rv-azul-texto)" },
  item: { display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--rv-borda)" },
  nome: { background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--rv-texto)", cursor: "pointer", textAlign: "left" },
  meta: { fontSize: 12.5, color: "var(--rv-texto-suave)", marginTop: 2 },
  botao: { border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "6px 10px", background: "var(--rv-fundo)", color: "var(--rv-texto)", cursor: "pointer", fontWeight: 700 },
};

export default function AlertasParcelaAcordo({ alertas, onAbrirFicha, mostrarResponsavel = false }) {
  const lista = ordenarAlertas(alertas);
  if (lista.length === 0) return null;
  return (
    <section style={S.painel} aria-label="Parcela de acordo próxima do vencimento" data-testid="alertas-parcela-acordo">
      <h3 style={S.titulo}>🔔 Parcela de acordo próxima do vencimento ({lista.length})</h3>
      {lista.map((a) => (
        <div key={chaveAlerta(a)} style={S.item} data-testid="alerta-parcela-item">
          <div style={{ minWidth: 0, flex: 1 }}>
            <button type="button" style={S.nome} onClick={() => onAbrirFicha && onAbrirFicha(a)} title="Abrir ficha do aluno">
              {a.aluno_nome || "Aluno"}
            </button>
            <div style={S.meta}>
              {descricaoAlerta(a)} · {formatarValorBRL(a.valor)} · vence em {formatarDataBR(a.vencimento)} · <strong>{rotuloDiasRestantes(a.dias_restantes)}</strong>
              {mostrarResponsavel ? ` · responsável: ${a.responsavel_email || "sem responsável"}` : ""}
            </div>
          </div>
          <button type="button" style={S.botao} onClick={() => onAbrirFicha && onAbrirFicha(a)}>
            Abrir ficha
          </button>
        </div>
      ))}
    </section>
  );
}
