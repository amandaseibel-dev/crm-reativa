import { SeisLinhas, AvisoConferencia } from "./SituacoesDaSafra";
import { S, moeda, dataCurta } from "./situacoesDaSafraFormato";

// AS SEIS LINHAS EM 2024, 2025 E 2026/1 — o mesmo cartão que 2026/2 já tinha.
//
// Pedido da gestão em 05/10/2026: Entrou, Pago, Negociado, Cancelado, Em aberto
// e Pendente, no mesmo desenho, em qualquer safra. O desenho vem de
// `SituacoesDaSafra.jsx`; os números vêm de `carteira_safra_situacoes(ano, sem)`.
//
// Nenhuma conta acontece aqui — nem a do percentual, que é share sobre Entrou e
// é calculado no desenho compartilhado, nem a invariante, que vem conferida do
// banco em `conferencia` e é só exibida.
//
// ---------------------------------------------------------------------------
// POR QUE ESTE COMPONENTE NÃO BUSCA MAIS NADA (07/10/2026)
//
// Ele chamava `carteira_safra_situacoes` por conta própria. A partir da nova
// Efetividade o MESMO payload alimenta o resumo executivo no topo da página
// (Universo recebido / Recuperado / Em aberto / Efetividade) e este cartão.
// Duas chamadas da mesma função numa abertura seriam, além de desperdício numa
// consulta ao vivo cara, duas fotografias de instantes diferentes: o topo
// poderia dizer um "em aberto" e o cartão outro, na mesma tela. Quem busca agora
// é a página, uma vez, e passa o resultado para os dois.
//
// ---------------------------------------------------------------------------
// O QUE SAIU DAQUI EM 07/10/2026, E PARA ONDE FOI
//
// "ALUNOS POR STATUS" SAIU. Era a lista quantitativa da importação acadêmica —
// categoria e contagem de aluno — e dizia a mesma coisa que o card "Status
// acadêmico por safra" dizia logo abaixo, na mesma página. A substituta é
// `ComposicaoAcademicaDoSaldo`, que traz as MESMAS categorias da MESMA
// importação e, além da contagem de alunos, os títulos em aberto, o saldo e a
// participação no saldo — ou seja, tudo o que os dois blocos traziam e a
// pergunta que nenhum dos dois respondia ("qual o saldo dos formados?").
// A informação não se perdeu: ela aparece uma vez só, e mais completa.
//
// A ABERTURA DE "PENDENTE" SAIU. Era um parágrafo corrido no rodapé, com os
// submotivos escritos em frase. Agora é o bloco `PendenciasDeValidacao`, em
// tabela, com alunos, títulos, valor e percentual por motivo — e com caminho
// para o registro individual na Fila Única. A linha "Pendente de classificação"
// continua aqui, no mesmo lugar e com o mesmo valor; o que mudou é onde ela é
// aberta.

export default function SeisLinhasDaSafra({ ano, semestre = null, dados, erro = "", carregando = false }) {
  if (carregando) return <p style={S.discreto}>Somando as seis linhas de {rotulo(ano, semestre)}…</p>;
  if (erro) return <p style={S.erro}>Não foi possível carregar as seis linhas: {erro}</p>;

  const s = dados?.situacoes || {};
  if (!Object.keys(s).length) return <p style={S.discreto}>Sem títulos em {rotulo(ano, semestre)}.</p>;

  const conf = dados?.conferencia || null;
  const historica = dados?.natureza === "COBERTURA_HISTORICA";

  return (
    <section style={{ marginTop: 18 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>As seis linhas da safra</h2>
        <span style={S.apoio}>{rotulo(ano, semestre)} · {dados?.fonte}</span>
      </div>

      <AvisoConferencia conferencia={conf} />

      <div style={S.cartao}>
        <div style={S.cartaoTopo}>
          <strong style={S.mesNome}>{rotulo(ano, semestre)}</strong>
          <span style={S.mesApoio}>
            {historica ? "cobertura histórica" : "carteira consolidada"}
          </span>
        </div>
        {/* `entrouCompacto`: o Universo recebido do resumo executivo, no topo
            da página, já é este mesmo Entrou. Aqui ele fica como a régua
            declarada das barras, não como manchete repetida. */}
        <SeisLinhas s={s} entrouCompacto />
      </div>

      {historica ? (
        <p style={S.rodape}>
          <strong>“Entrou” aqui não é a carteira original de {ano}.</strong> O CRM não guarda nada anterior a
          julho/2026, então o que existe desta safra é o <strong>saldo residual</strong> que ainda estava
          aberto quando a operação começou. O percentual de cada linha é share sobre esse residual, não sobre
          a carteira que a instituição emitiu em {ano}.
        </p>
      ) : (
        <p style={S.rodape}>
          <strong>Números ao vivo.</strong> Esta safra é recalculada a cada abertura da tela e a cada
          “Atualizar dados”, título a título — por isso dois carregamentos no mesmo dia podem diferir se
          houver cobrança acontecendo no intervalo.
        </p>
      )}

      <p style={S.rodape}>
        <strong>Um aluno pode aparecer em mais de uma situação</strong> — basta ter títulos em situações
        diferentes. As contagens de alunos <strong>não devem ser somadas</strong> entre linhas; só títulos e
        valores somam. A linha <strong>Pendente de classificação</strong> é aberta por motivo logo abaixo, em
        “Pendências de validação”.
      </p>
      {conf ? (
        <p style={S.rodape}>
          Conferência da invariante: Entrou {moeda(conf.entrou)} contra {moeda(conf.soma_das_linhas)} somados
          nas cinco linhas — diferença de {moeda(conf.diferenca)}. Medida a cada chamada; conta e registra,
          não corrige. Gerado em {dataCurta(dados?.gerado_em)}.
        </p>
      ) : null}
    </section>
  );
}

function rotulo(ano, semestre) {
  return semestre ? ano + "/" + semestre : String(ano);
}
