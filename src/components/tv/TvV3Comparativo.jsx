import { Tela, T, fs } from "./tvUI";

// TV V3: comparativo percentual, sem expor valores monetários.
// Consome exclusivamente o comparativo já calculado no snapshot do CRM.
export default function TvV3Comparativo({ snap }) {
  const dados = snap?.comparativo_ano;
  if (!dados) return null;
  const indicadores = [
    { nome: "Honorários recebidos", dados: dados.honorarios },
    { nome: "Recuperação bruta", dados: dados.recuperado },
  ].filter((item) => item.dados?.pct != null && Number.isFinite(Number(item.dados.pct)));
  const mes = dados.mes_nome || "Mês atual";
  return (
    <Tela titulo={`Comparativo mensal · ${mes}`} centralizado={false}>
      <div style={{ color: T.textoSuave, fontSize: fs(15, 1.7, 36), fontWeight: 700, textAlign: "center" }}>
        {dados.periodo || "Mesmo período"} · {dados.ano_anterior || "ano anterior"} × {dados.ano_atual || "ano atual"}
      </div>
      {indicadores.length === 0 ? (
        <div style={{ textAlign: "center", color: T.textoSuave, fontSize: fs(20, 2.4, 48) }}>
          Comparativo indisponível nesta atualização.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${indicadores.length}, minmax(0, 1fr))`, gap: "2.5vw", width: "100%", flex: 1, alignItems: "center" }}>
          {indicadores.map(({ nome, dados: indicador }) => {
            const pct = Number(indicador.pct);
            const positivo = pct >= 0;
            const cor = positivo ? T.verde : T.vermelho;
            return (
              <div key={nome} style={{ padding: "4vh 2.5vw", borderRadius: "2vw", border: "1px solid rgba(125,211,252,.25)", background: "linear-gradient(150deg, rgba(17,36,62,.94), rgba(9,19,36,.92))", boxShadow: "0 20px 70px rgba(0,0,0,.3)", textAlign: "center" }}>
                <div style={{ fontSize: fs(16, 1.8, 38), color: T.textoSuave, fontWeight: 800 }}>{nome}</div>
                <div style={{ fontSize: fs(54, 7.6, 170), lineHeight: 1.2, color: cor, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>
                  {positivo ? "+" : "−"}{Math.abs(pct).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                </div>
                <div style={{ fontSize: fs(14, 1.4, 30), color: T.textoSuave, fontWeight: 700 }}>
                  {positivo ? "Acima do mesmo período anterior" : "Abaixo do mesmo período anterior"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Tela>
  );
}
