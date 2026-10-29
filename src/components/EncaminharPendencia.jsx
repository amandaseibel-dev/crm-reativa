// ENCAMINHAR A PENDÊNCIA CLASSIFICADA — o botão que a triagem já pedia.
//
// POR QUE EXISTE. `vw_fila_pagamento_triagem` declara `CONFERIR_E_ENCERRAR` para
// 47 pagamentos (R$ 40.663,34, medido em 26/10/2026) e nenhuma tela a oferecia.
//
// ESCOPO: UMA AÇÃO. `ESCOLHER_ALUNO` foi retirada em 26/10/2026 e não tem
// caminho aqui — este componente não conhece aluno, não tem seleção de aluno e
// não chama `pagamento_vincular_aluno`. A busca manual de aluno da fila, que já
// existia em produção, segue intacta em `PagamentosSemAluno.jsx`, com o próprio
// aviso e o próprio portão; o que esta etapa faz é NÃO abrir uma segunda porta.
//
// A REGRA DE OURO DESTE COMPONENTE: dois passos, sempre. Primeiro a PRÉVIA, que
// o banco devolve e esta tela só traduz; depois a confirmação. Não há caminho
// em que um clique só grave algo — e a prévia é relida pelo banco na hora de
// gravar, porque o que a tela mostrou pode ter envelhecido.
//
// A AÇÃO NÃO MOVE DINHEIRO, e isso é conferido no banco, não prometido aqui: os
// dois passos são a decisão da fila e uma coluna de controle da conciliação. O
// aviso está em `ENCAMINHAMENTO_AVISO` e aparece dentro do painel, não num
// tooltip: quem confirma precisa ler.
import { useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import {
  ACOES_ENCAMINHAMENTO,
  AVISO_ORIGEM_BAIXA_REF,
  ENCAMINHAMENTO_AVISO,
  ROTULO_EVIDENCIA_ATUAL,
  ROTULO_MOTIVO_HISTORICO,
  historicoDaBaixa,
  identificacaoDaPrevia,
  rotuloDocumentoDaBaixa,
  impedimentoDoEncaminhamento,
  podeEncaminhar,
  rotuloRecusa,
  rotuloResultado,
  textoDaConfirmacao,
  validacoesDaPrevia,
} from "../utils/encaminhamentoConciliacao";

export default function EncaminharPendencia({ triagem, moeda, onConcluido }) {
  const [previa, setPrevia] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  // Linha sem ação DESTA etapa não ganha botão. Botão morto é pior que botão
  // ausente: ele promete e não entrega. É também o que mantém os 42
  // `ESCOLHER_ALUNO` sem porta nova, sem esconder a pendência da fila.
  if (!podeEncaminhar(triagem)) return null;

  const def = ACOES_ENCAMINHAMENTO[triagem.acao_sugerida];
  const pagamentoId = triagem.pagamento_id;

  async function abrir() {
    setCarregando(true);
    setMsg("");
    const { data, error } = await supabase.rpc("conciliacao_encaminhar_previa", {
      p_pagamento_id: pagamentoId,
    });
    setCarregando(false);
    if (error) {
      // A ausência da função (rollback aplicado) cai aqui e a tela diz isso em
      // vez de ficar girando. A pendência continua visível na fila.
      setMsg("Não foi possível carregar a prévia: " + error.message);
      return;
    }
    setPrevia(data || null);
  }

  function fechar() {
    setPrevia(null);
    setMsg("");
  }

  async function confirmar() {
    const impede = impedimentoDoEncaminhamento({ previa });
    if (impede) {
      setMsg(impede);
      return;
    }

    if (!window.confirm(textoDaConfirmacao({ previa, moeda }))) return;

    setSalvando(true);
    setMsg("");
    const { data, error } = await supabase.rpc("conciliacao_encaminhar_confirmar", {
      p_pagamento_id: pagamentoId,
      p_acao: previa.acao,
      p_confirmar: true,
    });
    setSalvando(false);
    if (error) {
      setMsg("Erro: " + error.message);
      return;
    }
    if (!data?.ok) {
      // Recusa do banco é informação, não falha da pessoa: mostra o motivo
      // nomeado e mantém o painel aberto para ela ver as validações.
      setMsg(rotuloRecusa(data?.motivo));
      if (data && typeof data === "object" && data.validacoes) setPrevia(data);
      return;
    }
    fechar();
    if (onConcluido) onConcluido();
  }

  if (!previa) {
    return (
      <div style={caixa}>
        <div style={topo}>
          <span style={rotulo}>encaminhamento</span>
          <span style={S.cardCpf}>{def.explica}</span>
        </div>
        <div style={linhaAcoes}>
          <button type="button" onClick={abrir} disabled={carregando} style={S.btnVinc}>
            {carregando ? "…" : def.rotulo}
          </button>
          <span style={S.cardCpf}>abre a conferência antes de qualquer confirmação</span>
        </div>
        {msg ? <div style={erro}>{msg}</div> : null}
      </div>
    );
  }

  const validacoes = validacoesDaPrevia(previa);
  const impede = impedimentoDoEncaminhamento({ previa });
  const ident = identificacaoDaPrevia(previa);
  const baixa = historicoDaBaixa(previa);

  return (
    <div style={caixa}>
      <div style={topo}>
        <span style={rotulo}>encaminhamento · conferência</span>
        <span style={previa.aprovado ? { ...S.chip, ...S.chipOk } : { ...S.chip, ...S.chipPend }}>
          {previa.aprovado ? "prévia aprovada" : "prévia não aprovada"}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={fechar} style={S.btnGhostClaro}>
          Fechar
        </button>
      </div>

      {/* QUEM E QUAL ACORDO. Sem isto, a gestão decidia sobre um boleto e um
          valor, sem saber de quem era a dívida. O acordo já vinha na prévia e
          não era exibido; o aluno vem do bloco que a fachada monta. Falta
          qualquer um dos dois -> "não informado — conferir", nunca deduzido. */}
      <div style={bloco}>
        <span style={rotulo}>identificação</span>
        <div style={grade}>
          <div style={item}>
            <span style={itemRotulo}>Aluno</span>
            <span style={ident.aluno.temVinculo ? itemDetalhe : itemPendencia}>
              {ident.aluno.nome}
              {ident.aluno.temVinculo ? ` · CPF ${ident.aluno.cpf}` : ""}
            </span>
          </div>
          <div style={item}>
            <span style={itemRotulo}>Acordo</span>
            <span style={itemDetalhe}>
              {ident.acordo.numero} · {ident.acordo.status}
              {ident.acordo.parcelas ? ` · ${ident.acordo.parcelas} parcelas` : ""}
            </span>
          </div>
        </div>
      </div>

      {/* O MOTIVO É HISTÓRICO, e tem dono: foi o motor que o escreveu, na
          importação. Fica com rótulo próprio para ninguém o ler como veredito
          sobre o que existe no banco hoje -- ele diz "nao ha registro de quem
          baixou" querendo dizer que `origem_baixa_ref` está nula. */}
      <div style={bloco}>
        <span style={rotulo}>{ROTULO_MOTIVO_HISTORICO}</span>
        <span style={texto}>{previa.motivo_da_pendencia || "—"}</span>
      </div>

      {/* O QUE O BANCO GUARDA HOJE, ao lado do motivo e sem o contradizer. É
          aqui que aparece o documento que de fato baixou a parcela. */}
      <div style={bloco}>
        <span style={rotulo}>{ROTULO_EVIDENCIA_ATUAL}</span>
        <div style={grade}>
          <div style={item}>
            <span style={itemRotulo}>Baixada em</span>
            <span style={itemDetalhe}>{baixa.pagoEm}</span>
          </div>
          <div style={item}>
            <span style={itemRotulo}>Confirmada por</span>
            <span style={itemDetalhe}>{baixa.responsavel}</span>
          </div>
          {/* DESCRITIVO, nunca conclusivo. Documento diferente do boleto é
              compatível com a MESMA parcela reemitida -- os 4 dígitos finais
              são sequência de emissão, não número de parcela. Quem pode julgar
              a origem é a prévia, no banco; a tela mostra e pede conferência. */}
          <div style={item}>
            <span style={itemRotulo}>{rotuloDocumentoDaBaixa(baixa)}</span>
            <span style={baixa.documentoDifereDoBoleto === true ? itemPendencia : itemDetalhe}>
              {baixa.documento}
            </span>
          </div>
          <div style={item}>
            <span style={itemRotulo}>Referência da baixa</span>
            <span style={itemPendencia}>{baixa.origemBaixaRef}</span>
          </div>
          {baixa.temObservacao ? (
            <div style={item}>
              <span style={itemRotulo}>Observação da parcela</span>
              <span style={itemDetalhe}>{baixa.observacao}</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* AS VALIDAÇÕES, uma linha cada, com o detalhe que o banco mediu. É a
          evidência: nada aqui é opinião da tela. */}
      {validacoes.length > 0 ? (
        <div style={bloco}>
          <span style={rotulo}>evidências conferidas no banco</span>
          <div style={grade}>
            {validacoes.map((v) => (
              <div key={v.codigo} style={item}>
                <span style={v.ok ? marcaOk : marcaFalta}>{v.ok ? "✓" : "✗"}</span>
                <span style={itemRotulo}>{v.rotulo}</span>
                <span style={itemDetalhe}>{v.detalhe}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* O RESULTADO ESPERADO, antes de confirmar. Os passos vêm do banco, na
          ordem em que ele os executa -- esconder o segundo passo faria a pessoa
          aprovar metade do que a função faz. */}
      <div style={bloco}>
        <span style={rotulo}>o que vai acontecer</span>
        <span style={texto}>{rotuloResultado(previa.resultado_esperado)}</span>
        {Array.isArray(previa.passos) && previa.passos.length > 1 ? (
          <span style={S.cardCpf}>
            em {previa.passos.length} passos, na mesma transação: se o último recusar, nada é gravado
          </span>
        ) : null}
      </div>

      {/* O LIMITE, dito antes de confirmar: encerrar fecha a pendência e NÃO
          liga este pagamento à parcela que ele pagou. */}
      <div style={avisoRef}>{AVISO_ORIGEM_BAIXA_REF}</div>

      <div style={avisoBox}>{ENCAMINHAMENTO_AVISO}</div>

      <div style={linhaAcoes}>
        <button
          type="button"
          onClick={confirmar}
          disabled={salvando || Boolean(impede)}
          style={impede ? S.btnGhostClaro : S.btnConf}
          title={impede || def.aviso}
        >
          {salvando ? "…" : def.verbo}
        </button>
        {impede ? <span style={S.cardCpf}>{impede}</span> : null}
      </div>

      {msg ? <div style={erro}>{msg}</div> : null}
    </div>
  );
}

const caixa = {
  borderTop: "1px solid var(--rv-borda-suave)",
  padding: "10px 16px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--rv-verde-ok-fundo)",
};
const topo = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const rotulo = {
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--rv-texto-fraco)",
};
const bloco = { display: "flex", flexDirection: "column", gap: 4 };
const texto = { fontSize: 12.5, color: "var(--rv-texto-forte)", fontWeight: 600 };
const grade = { display: "flex", flexDirection: "column", gap: 3 };
const item = { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" };
const itemRotulo = { fontSize: 12.5, fontWeight: 700, color: "var(--rv-tinta)" };
const itemDetalhe = { fontSize: 11.5, color: "var(--rv-texto-suave)" };
// Pendência de conferência: cor própria, para "não informado" não passar por
// dado. Âmbar, nunca vermelho: aqui não há erro apontado, há conferência pedida.
const itemPendencia = { fontSize: 11.5, fontWeight: 700, color: "var(--rv-ambar-texto)" };
const avisoRef = {
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--rv-ambar-texto)",
  background: "var(--rv-ambar-fundo)",
  border: "1px solid var(--rv-ambar-borda)",
  borderRadius: 8,
  padding: "7px 10px",
};
const marcaOk = { fontWeight: 800, color: "var(--rv-verde-ok-texto)" };
const marcaFalta = { fontWeight: 800, color: "var(--rv-vermelho-texto)" };
const linhaAcoes = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const avisoBox = {
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--rv-texto-forte)",
  background: "var(--rv-superficie)",
  border: "1px solid var(--rv-borda)",
  borderRadius: 8,
  padding: "7px 10px",
};
const erro = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--rv-vermelho-texto)",
  background: "var(--rv-vermelho-fundo)",
  border: "1px solid var(--rv-vermelho-borda)",
  borderRadius: 8,
  padding: "6px 10px",
};
