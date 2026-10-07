// AS SEIS LINHAS DA SAFRA — o layout, em um lugar só.
//
// Este arquivo nasceu de `EfetividadePorVencimento.jsx`, que o usava em 2026/2.
// Em 05/10/2026 a gestão pediu as MESMAS seis linhas em 2024, 2025 e 2026/1, e
// duas cópias do mesmo desenho divergiriam na primeira correção. Então o corpo
// saiu de lá e virou isto; o cartão de 2026/2 passou a importar daqui, e é por
// isso que os testes dele seguem valendo como rede de segurança deste arquivo.
//
// Nenhuma conta acontece aqui. Quem soma é o banco:
// `carteira_2026_2_por_vencimento()` em 2026/2 e `carteira_safra_situacoes()`
// em 2024, 2025 e 2026/1. O front desenha o que recebe e não recompõe situação
// nenhuma — nem para fechar a invariante.
//
// Formatadores, cores, catálogo das linhas e estilos moram em
// `situacoesDaSafraFormato.js`: este arquivo exporta SÓ componentes, como a
// catraca do lint exige.

import {
  SITUACOES, PENDENTE, vazio, moeda, num, plural, S,
} from "./situacoesDaSafraFormato";


// Entrou é a régua do cartão: é o 100% das barras e o denominador dos
// percentuais. Por isso vem inteiro em cima, e não como mais uma linha.
//
// `entrouCompacto` existe por causa da Efetividade redesenhada (07/10/2026):
// lá o mesmo "Entrou" já é o primeiro indicador do resumo executivo, no topo da
// página, com o mesmo valor e os mesmos alunos e títulos. Repeti-lo em corpo 24
// logo abaixo é mostrar o mesmo número duas vezes com dois nomes — exatamente o
// que o redesenho veio remover. Compacto, ele continua DECLARANDO a régua das
// barras (sem denominador declarado, percentual não se lê) sem ser manchete
// pela segunda vez.
//
// Em 2026/2 (`EfetividadePorVencimento`) nada muda: lá não há resumo executivo
// acima, e o Entrou de cada mês é a manchete do cartão daquele mês.
export function SeisLinhas({ s, composicao, entrouCompacto = false }) {
  const entrou = s.entrou || vazio();
  const base = Number(entrou.valor || 0);
  return (
    <>
      {entrouCompacto ? (
        <div style={S.entrouCompacto}>
          <span style={S.entrouRotulo}>Entrou</span>
          <span style={S.entrouCompactoValor}>
            {moeda(entrou.valor)} — é a régua das barras abaixo (100%)
          </span>
        </div>
      ) : (
        <div style={S.entrou}>
          <span style={S.entrouRotulo}>Entrou</span>
          <strong style={S.entrouValor}>{moeda(entrou.valor)}</strong>
          <span style={S.entrouApoio}>
            {plural(entrou.alunos, "aluno", "alunos")} · {plural(entrou.titulos, "título", "títulos")}
          </span>
        </div>
      )}
      <div>
        {SITUACOES.map((c) => (
          <Linha key={c.k} cfg={c} d={s[c.k] || vazio()} base={base}
                 composicao={c.k === "pago" ? composicao : null} />
        ))}
      </div>
      <div style={S.separador} />
      <Linha cfg={PENDENTE} d={s.pendente || vazio()} base={base} />
    </>
  );
}

export function Linha({ cfg, d, base, composicao }) {
  const valor = Number(d.valor || 0);
  const share = base > 0 ? (valor / base) * 100 : 0;
  return (
    <div style={S.linha}>
      <div style={S.linhaTopo}>
        <span style={S.linhaRotulo}>
          <span style={{ ...S.ponto, background: cfg.cor }} aria-hidden="true" />{cfg.r}
        </span>
        <strong style={S.linhaValor}>{moeda(valor)}</strong>
        <span style={{ ...S.linhaPct, color: cfg.cor }}>
          {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
        </span>
      </div>
      <span style={S.linhaApoio}>
        {plural(d.alunos, "aluno", "alunos")} · {plural(d.titulos, "título", "títulos")} · {cfg.ajuda}
      </span>
      {/* Um total principal de Pago; a composição fica DENTRO da linha, nunca
          como uma segunda métrica ao lado. Rateado não é pagamento
          identificado naquele título, e a tela diz isso com todas as letras. */}
      {composicao ? (
        <span style={S.composicao}>
          <span>Atribuído diretamente: <strong>{moeda(composicao.atribuido)}</strong></span>
          <span>Por rateio: <strong>{moeda(composicao.rateado)}</strong></span>
        </span>
      ) : null}
      <div style={S.trilho}>
        <div style={{ ...S.barra, width: Math.min(share, 100) + "%",
                      minWidth: valor > 0 ? 4 : 0, background: cfg.cor }} />
      </div>
    </div>
  );
}

// Quantos ALUNOS estão em cada status — sempre o rótulo que a própria base dá,
// nunca uma etiqueta nova nossa. Em 2026/2 vem da `sub_faixa` do classificador;
// em 2024, 2025 e 2026/1 vem da situação acadêmica importada.
export function AlunosPorStatus({ lista, titulo = "Alunos por status", rodape = null }) {
  if (!lista || !lista.length) return null;
  return (
    <div style={S.statusBloco}>
      <span style={S.statusTitulo}>{titulo}</span>
      <ul style={S.statusLista}>
        {lista.map((s) => (
          <li key={s.status} style={S.statusItem}>
            <span style={S.statusNome}>{s.status}</span>
            <span style={S.statusQtd}>{num(s.alunos)}</span>
          </li>
        ))}
      </ul>
      {rodape ? <p style={{ ...S.rodape, marginTop: 8 }}>{rodape}</p> : null}
    </div>
  );
}

// Conta e registra, não corrige: se a soma das linhas deixar de bater com
// Entrou, o aviso sobe e nenhum número é ajustado por conta própria.
export function AvisoConferencia({ conferencia }) {
  if (!conferencia || conferencia.fecha !== false) return null;
  return (
    <p style={S.erro}>
      ⚠️ A soma das situações difere de Entrou em {moeda(conferencia.diferenca)}. Os números estão como
      vieram do banco — nada foi ajustado para fechar.
    </p>
  );
}
