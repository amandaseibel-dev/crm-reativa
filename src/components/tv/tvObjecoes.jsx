import { Tela, RaioReativa, T, fs, layout } from "./tvUI";
import { OBJECOES } from "../../conteudo/objecoesNegociacao";

// =============================================================================
// TV ReATIVA — TELA "QUEBRAS DE OBJEÇÃO"
// -----------------------------------------------------------------------------
// Arquivo próprio exportando só o componente, como tvMetaDoMes e tvMagicNumber:
// em tvTelas.jsx cada tela soma um erro de react-refresh na catraca de lint.
//
// O conteúdo é o MESMO que o operador consulta no Portal Operacional — vem de
// src/conteudo/objecoesNegociacao.js, importado pelos dois. Não passa pelo
// snapshot: é texto institucional, não dado de operação. O telão continua sem
// consultar nada, e o payload não cresce.
//
// UMA objeção por slide, de propósito. São 35, e o que o operador precisa a
// quatro metros de distância é a frase que o aluno disse e a frase que ele
// responde — não um resumo de seis campos que ninguém lê de longe. Objetivo e
// atenção ficam no Portal, onde há tempo de ler.
// =============================================================================

export default function TelaObjecoes({ indiceGiro = 0 }) {
  if (OBJECOES.length === 0) {
    return (
      <Tela titulo="Quebras de Objeção" icone="🛡️">
        <div style={vazio}>Nenhuma quebra de objeção cadastrada.</div>
      </Tela>
    );
  }

  // `indiceGiro` é o contador de voltas do carrossel, que o orquestrador já
  // passa para todo slide. Uma objeção por volta: as 35 passam em 35 voltas,
  // sem repetir e sem depender de nada que venha do banco.
  const it = OBJECOES[Math.abs(Math.trunc(Number(indiceGiro) || 0)) % OBJECOES.length];

  return (
    <Tela titulo="Quebras de Objeção" icone="🛡️">
      <div style={corpo}>
        <div style={blocoAluno}>
          <div style={rotuloAluno}>O aluno diz</div>
          <div style={fala}>“{it.pergunta}”</div>
        </div>

        <div style={seta}><RaioReativa tamanho={fs(26, 2.8, 64)} /></div>

        <div style={blocoResposta}>
          <div style={rotuloResposta}>Responda assim</div>
          <div style={resposta}>{it.principal}</div>
          {it.firme && (
            <div style={linhaFirme}>
              <span style={seloFirme}>Se insistir</span>
              <span style={textoApoio}>{it.firme}</span>
            </div>
          )}
          {!it.firme && it.alternativa && (
            <div style={linhaAlternativa}>
              <span style={seloAlternativa}>Ou</span>
              <span style={textoApoio}>{it.alternativa}</span>
            </div>
          )}
        </div>
      </div>

      <div style={rodape}>
        Objeção {(Math.abs(Math.trunc(Number(indiceGiro) || 0)) % OBJECOES.length) + 1} de {OBJECOES.length}
        <span style={sep}>·</span>
        Todas no Portal Operacional, em Quebras de Objeção
      </div>
    </Tela>
  );
}

const corpo = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  gap: "clamp(10px, 1.6vh, 26px)", width: "min(88vw, 1700px)", flex: "0 0 auto", minHeight: 0,
};
const blocoAluno = {
  ...layout.card, width: "100%", alignItems: "center", textAlign: "center",
  gap: "0.8vh", background: "rgba(148,163,184,0.10)",
};
const rotuloAluno = {
  fontSize: fs(12, 1.2, 26), fontWeight: 800, color: T.textoMudo,
  textTransform: "uppercase", letterSpacing: "0.14em",
};
const fala = {
  fontSize: fs(24, 3.0, 76), fontWeight: 900, color: T.texto, lineHeight: 1.1,
  textShadow: "0 0 30px rgba(59,130,246,0.25)",
};
const seta = { display: "flex", justifyContent: "center", flex: "0 0 auto" };
const blocoResposta = {
  ...layout.card, width: "100%", alignItems: "stretch", gap: "1vh",
  background: "linear-gradient(135deg, rgba(37,99,235,0.20), rgba(34,197,94,0.12))",
  border: "1px solid rgba(125,211,252,0.42)",
};
const rotuloResposta = {
  fontSize: fs(12, 1.2, 26), fontWeight: 800, color: T.azulClaro,
  textTransform: "uppercase", letterSpacing: "0.14em",
};
const resposta = {
  fontSize: fs(17, 2.0, 50), fontWeight: 700, color: T.texto, lineHeight: 1.28,
};
const linhaFirme = {
  display: "flex", alignItems: "baseline", gap: "1vw", flexWrap: "wrap",
  borderTop: "1px solid rgba(148,163,184,0.22)", paddingTop: "1vh",
};
const linhaAlternativa = { ...linhaFirme };
const seloBase = {
  ...layout.selo, flex: "0 0 auto",
};
const seloFirme = { ...seloBase, color: T.ambar, borderColor: T.ambar };
const seloAlternativa = { ...seloBase, color: T.azulClaro, borderColor: T.azulClaro };
const textoApoio = {
  fontSize: fs(13, 1.45, 34), fontWeight: 600, color: T.textoSuave, lineHeight: 1.25, flex: "1 1 0",
};
const rodape = {
  display: "flex", alignItems: "baseline", justifyContent: "center", flexWrap: "wrap",
  gap: "0.9vw", flex: "0 0 auto", fontSize: fs(12, 1.2, 26), fontWeight: 600, color: T.textoSuave,
};
const sep = { color: "rgba(148,163,184,0.5)" };
const vazio = {
  fontSize: fs(16, 1.7, 42), color: T.textoMudo, fontWeight: 600, textAlign: "center",
};
