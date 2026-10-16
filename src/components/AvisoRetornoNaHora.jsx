// Caixa que aparece no centro da tela quando chega a hora de um retorno que o
// operador agendou. Componente PURO: recebe o retorno e os callbacks; quem
// decide QUANDO mostrar e src/utils/alarmeRetorno.js.
//
// Desenho pedido pela gestao em 15/10/2026: "uma caixinha com o nome do aluno
// no horario e abrir a ficha dele para entrar em contato". Por isso o botao
// principal abre a ficha -- a caixa nao e um lembrete para ler e fechar, e o
// comeco do atendimento.
import { formatarValorBRL } from "../utils/alertasParcela";
import { minutosDeAtraso, normalizarHora } from "../utils/alarmeRetorno";

const S = {
  fundo: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,23,42,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
    padding: 16,
  },
  caixa: {
    width: "min(420px, 100%)",
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda)",
    borderRadius: 16,
    boxShadow: "0 24px 60px rgba(15,23,42,0.35)",
    padding: "20px 22px",
    textAlign: "center",
  },
  chapeu: { fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rv-roxo)", margin: "0 0 6px" },
  nome: { fontSize: 21, fontWeight: 800, color: "var(--rv-texto)", margin: "0 0 4px", lineHeight: 1.2 },
  hora: { fontSize: 13.5, fontWeight: 700, color: "var(--rv-texto-suave)", margin: "0 0 2px" },
  atraso: { color: "var(--rv-vermelho)" },
  dados: { fontSize: 13.5, color: "var(--rv-texto-suave)", margin: "8px 0 16px", lineHeight: 1.5 },
  telefone: { fontSize: 17, fontWeight: 800, color: "var(--rv-texto)", letterSpacing: "0.02em" },
  botoes: { display: "flex", flexDirection: "column", gap: 8 },
  principal: {
    border: "none",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14.5,
    fontWeight: 800,
    cursor: "pointer",
    background: "var(--rv-azul)",
    color: "#fff",
  },
  linhaSecundaria: { display: "flex", gap: 8 },
  secundario: {
    flex: 1,
    border: "1px solid var(--rv-borda)",
    borderRadius: 10,
    padding: "9px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    background: "var(--rv-fundo)",
    color: "var(--rv-texto)",
  },
};

export default function AvisoRetornoNaHora({
  retorno,
  horaAgora,
  minutosParaLembrar = 10,
  onAbrirFicha,
  onLembrarDepois,
  onMarcarFeito,
  ocupado = false,
}) {
  if (!retorno) return null;
  const atraso = minutosDeAtraso(retorno.hora_retorno, horaAgora);
  const hora = normalizarHora(retorno.hora_retorno);

  return (
    <div style={S.fundo} role="dialog" aria-modal="true" aria-label="Hora do retorno" data-testid="aviso-retorno-na-hora">
      <div style={S.caixa}>
        <p style={S.chapeu}>⏰ Hora do retorno</p>
        <p style={S.nome}>{retorno.nome}</p>
        <p style={{ ...S.hora, ...(atraso > 0 ? S.atraso : {}) }}>
          Combinado para as {hora}
          {atraso > 0 ? ` · há ${atraso} min` : ""}
        </p>
        <div style={S.dados}>
          {retorno.telefone ? (
            <div style={S.telefone}>{retorno.telefone}</div>
          ) : (
            <div>Sem telefone na ficha</div>
          )}
          {Number(retorno.valor_em_aberto) > 0 ? <div>{formatarValorBRL(retorno.valor_em_aberto)} em aberto</div> : null}
        </div>
        <div style={S.botoes}>
          <button type="button" style={S.principal} onClick={() => onAbrirFicha && onAbrirFicha(retorno)}>
            Abrir ficha e ligar
          </button>
          <div style={S.linhaSecundaria}>
            <button
              type="button"
              style={S.secundario}
              onClick={() => onLembrarDepois && onLembrarDepois(retorno, minutosParaLembrar)}
            >
              Lembrar em {minutosParaLembrar} min
            </button>
            <button
              type="button"
              style={S.secundario}
              disabled={ocupado}
              onClick={() => onMarcarFeito && onMarcarFeito(retorno)}
              title="Marca o contato como feito e tira o aviso do dia"
            >
              {ocupado ? "…" : "✓ Já falei"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
