import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// TRIAGEM DA FILA DE CONFIRMAÇÃO — o que cada decisão vai produzir.
//
// Pedido da gestão em 08/10/2026: priorizar os alunos com confirmação aberta
// sabendo, antes de decidir, quais decisões encerram a cobrança, quais devolvem
// saldo elegível para retorno e quais casos têm OUTRO bloqueio que sobrevive à
// decisão. E se os elegíveis estão de fato na mão de um operador.
//
// SÓ LEITURA, e de propósito. Este painel não tem botão de ação nenhum: não
// libera aluno, não remove suspensão, cancelamento nem "não acionar", não
// redistribui e não decide. Quem decide são as ações que a aba já tem, uma a
// uma, com as travas e a auditoria delas.
//
// NENHUMA REGRA MORA AQUI. A classificação vem de
// `confirmacao_pendente_triagem()`, que lê os mesmos campos que a Fila
// Operacional e esta aba já usam. O front desenha o que recebe.
//
// POR QUE "ENCERRA A COBRANÇA" PODE VIR VAZIO, E ISSO É INFORMAÇÃO. Medido em
// produção em 08/10/2026: nenhum dos 201 pendentes está com saldo zerado. Ou
// seja, hoje não existe grupo que a decisão encerre por si — encerrar é decisão
// de gestão (pago fora do sistema, conciliação bancária, saldo residual
// indevido), que é exatamente o que `confirmar_saldo_zero_retirar_filas` exige
// motivo escrito para fazer. O card aparece com zero em vez de desaparecer:
// sumir faria parecer que a categoria não existe.
//
// E POR QUE NINGUÉM APARECE "DISPONÍVEL" HOJE. Enquanto a confirmação está
// aberta o aluno está protegido e sai da Fila Operacional — é o desenho de
// `docs/PROTECAO-CONFIRMACAO-FINANCEIRA.md`, e nada aqui o altera. O que o
// painel mede é outra coisa: resolvida a confirmação, o caso cai na mão de quem.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const dia = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");
const diasDesde = (v) =>
  v ? Math.floor((Date.now() - new Date(v).getTime()) / 86400000) : null;

// Os três grupos, na ordem em que a gestão lê: o que sai da cobrança, o que
// volta para ela, e o que não vai a lugar nenhum sem outra decisão.
const GRUPOS = [
  {
    chave: "ENCERRA_COBRANCA",
    titulo: "A decisão encerra a cobrança",
    ajuda: "Sem saldo a cobrar depois de resolvido. Quitar e encerrar, ou confirmar saldo zero, fecha o caso — ele não volta para o operador.",
    cor: "var(--rv-texto-suave)",
    vazio: "Nenhum hoje: todos os pendentes têm saldo em aberto. Encerrar a cobrança aqui seria decisão de gestão, com motivo escrito — não é dedução do dado.",
  },
  {
    chave: "DEVOLVE_SALDO",
    titulo: "Devolve saldo elegível para retorno",
    ajuda: "Tem saldo em aberto e nenhum outro bloqueio. Confirmar o pagamento (ou rejeitá-lo) devolve o que sobrar à cobrança.",
    cor: "var(--rv-verde-ok)",
    vazio: "Nenhum caso nesta condição.",
  },
  {
    chave: "OUTRO_BLOQUEIO",
    titulo: "Tem outro bloqueio",
    ajuda: "Resolver a confirmação não basta: o caso está encerrado, suspenso, cancelado, jurídico, marcado “não acionar” ou sem operador. O bloqueio sobrevive à decisão.",
    cor: "var(--rv-ambar-texto)",
    vazio: "Nenhum caso com bloqueio adicional.",
  },
];

// Para onde os elegíveis voltam. `CARTEIRA_GERAL` é o achado que importa: a
// Carteira Geral é `ativo = false` por desenho, justamente para ficar fora de
// todo seletor de pessoa — quem está lá não volta para operador nenhum.
const DESTINOS = {
  OPERADOR_ATIVO: {
    r: "Com operador ativo",
    ajuda: "Resolvida a confirmação, o caso volta para a fila desse operador.",
    cor: "var(--rv-verde-ok)",
  },
  CARTEIRA_GERAL: {
    r: "Parados na Carteira Geral",
    ajuda: "A Carteira Geral não é pessoa: resolver a confirmação não entrega o caso a ninguém. Precisa de decisão de distribuição, que é outra frente.",
    cor: "var(--rv-ambar-texto)",
  },
  NAO_E_OPERADOR_ATIVO: {
    r: "Com quem não é operador ativo",
    ajuda: "O caso está com perfil que não atende fila (gerência) ou com usuário inativo. Também não volta para a operação sozinho.",
    cor: "var(--rv-ambar-texto)",
  },
};

export default function TriagemConfirmacaoPendente({ recarga = 0 }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    // O reset entra DENTRO da função assíncrona: setState no corpo do efeito
    // cascateia render e a catraca do lint reprova.
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("confirmacao_pendente_triagem");
      if (!ativo) return;
      if (error) { setErro(error.message || "falha ao consultar"); setDados(null); }
      else setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [recarga]);

  if (carregando) return <p style={E.discreto}>Triando a fila de confirmação…</p>;
  if (erro) {
    return (
      <p style={E.erro}>
        Não foi possível triar a fila de confirmação: {erro}. A lista abaixo não depende desta consulta
        e segue válida.
      </p>
    );
  }
  if (!dados) return null;

  const porGrupo = new Map((dados.grupos || []).map((g) => [g.grupo, g]));
  const porDestino = new Map((dados.destino_dos_elegiveis || []).map((d) => [d.destino, d]));
  const elegiveis = porGrupo.get("DEVOLVE_SALDO");

  return (
    <section style={E.bloco}>
      <div style={E.cabecalho}>
        <strong style={E.titulo}>Triagem: o que cada decisão vai produzir</strong>
        <span style={E.apoio}>
          {num(dados.alunos_pendentes)} alunos · {num(dados.solicitacoes_abertas)} solicitações abertas
        </span>
      </div>

      <div style={E.grade}>
        {GRUPOS.map((g) => {
          const d = porGrupo.get(g.chave);
          const n = Number(d?.alunos || 0);
          const espera = diasDesde(d?.espera_mais_antiga);
          return (
            <article key={g.chave} style={{ ...E.card, borderLeft: `3px solid ${g.cor}` }}>
              <span style={E.cardRotulo}>{g.titulo}</span>
              <strong style={{ ...E.cardNumero, color: g.cor }}>{num(n)}</strong>
              {n > 0 ? (
                <>
                  <span style={E.cardValor}>{moeda(d.saldo)} de saldo</span>
                  <span style={E.cardApoio}>
                    {moeda(d.valor_informado)} informado pela operação
                    {espera != null ? ` · mais antigo há ${num(espera)} dias (${dia(d.espera_mais_antiga)})` : ""}
                  </span>
                  {/* A composição do bloqueio, para não ser caixa-preta. Os
                      motivos se sobrepõem: um caso pode estar encerrado E com
                      status de bloqueio, então eles não somam. */}
                  {g.chave === "OUTRO_BLOQUEIO" ? (
                    <span style={E.cardApoio}>
                      {num(d.com_status_bloqueio)} com status de suspensão/cancelamento/jurídico ·{" "}
                      {num(d.com_caso_encerrado)} com caso encerrado · {num(d.com_nao_acionar)} marcados
                      “não acionar”. Os motivos se sobrepõem e não somam.
                    </span>
                  ) : null}
                  <span style={E.cardAjuda}>{g.ajuda}</span>
                  {/* `sem_operador` NAO entra na composicao acima: neste grupo
                      ele e tautologico (o grupo E "sem caso livre com
                      operador", entao o campo volta o tamanho do grupo).
                      Medido em producao em 08/10/2026: dos 33, so 7 nao tem
                      operador nenhum -- 26 tem operador e o caso esta bloqueado
                      por status. Exibi-lo como "sem operador" apontava a causa
                      errada. */}
                  {g.chave === "OUTRO_BLOQUEIO" ? (
                    <span style={E.cardApoio}>
                      Nenhum deles tem caso livre com operador — é isso que define o grupo. A causa
                      pode ser o status do caso, o encerramento ou a ausência de operador.
                    </span>
                  ) : null}
                </>
              ) : (
                <span style={E.cardAjuda}>{g.vazio}</span>
              )}
            </article>
          );
        })}
      </div>

      {/* A CONFERÊNCIA QUE A GESTÃO PEDIU: os elegíveis estão de fato na mão de
          um operador? Só aparece quando há elegíveis. */}
      {elegiveis && Number(elegiveis.alunos) > 0 ? (
        <div style={E.destinos}>
          <span style={E.destinosTitulo}>
            Dos {num(elegiveis.alunos)} elegíveis, para onde a decisão os devolve
          </span>
          <ul style={E.destinosLista}>
            {Object.keys(DESTINOS).map((k) => {
              const d = porDestino.get(k);
              if (!d) return null;
              const cfg = DESTINOS[k];
              return (
                <li key={k} style={E.destinoItem} title={cfg.ajuda}>
                  <span style={{ ...E.destinoPonto, background: cfg.cor }} aria-hidden="true" />
                  <span style={E.destinoRotulo}>{cfg.r}</span>
                  <strong style={E.destinoValor}>{num(d.alunos)}</strong>
                  <span style={E.destinoSaldo}>{moeda(d.saldo)}</span>
                </li>
              );
            })}
          </ul>
          {porDestino.get("CARTEIRA_GERAL") || porDestino.get("NAO_E_OPERADOR_ATIVO") ? (
            <p style={E.aviso}>
              <strong>
                {num(Number(porDestino.get("CARTEIRA_GERAL")?.alunos || 0)
                     + Number(porDestino.get("NAO_E_OPERADOR_ATIVO")?.alunos || 0))}{" "}
                dos elegíveis não voltam para operador nenhum
              </strong>{" "}
              ao serem resolvidos: estão na Carteira Geral ou com quem não atende fila. Confirmar o
              pagamento deles resolve o financeiro, mas a cobrança só recomeça com uma decisão de
              distribuição — que não é feita por esta aba.
            </p>
          ) : null}
        </div>
      ) : null}

      <p style={E.rodape}>
        <strong>Este painel não libera ninguém.</strong> Enquanto a confirmação está aberta o aluno fica
        fora da Fila Operacional de propósito, com o selo “Aguardando confirmação de pagamento” — a
        proteção não é tocada aqui. Nenhuma suspensão, cancelamento ou “não acionar” é removido: a
        triagem só mostra o que sobra depois de cada decisão, para a fila ser priorizada com
        conhecimento. Quem decide são as ações de sempre, caso a caso.
      </p>
      {dados.gerado_em ? (
        <p style={E.rodape}>Lido ao vivo em {dia(dados.gerado_em)}.</p>
      ) : null}
    </section>
  );
}

const E = {
  bloco: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
           borderRadius: 14, padding: "14px 16px", marginBottom: 14 },
  cabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between",
               gap: 10, flexWrap: "wrap", marginBottom: 12 },
  titulo: { fontSize: 14, fontWeight: 800 },
  apoio: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 },
  card: { display: "flex", flexDirection: "column", gap: 3, background: "var(--rv-fundo-suave)",
          borderRadius: 10, padding: "11px 13px", minWidth: 0 },
  cardRotulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase",
                color: "var(--rv-texto-fraco)" },
  cardNumero: { fontSize: 26, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums" },
  cardValor: { fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  cardApoio: { fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.45,
               fontVariantNumeric: "tabular-nums" },
  cardAjuda: { fontSize: 11.5, color: "var(--rv-texto-fraco)", lineHeight: 1.45, marginTop: 3 },

  destinos: { marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--rv-borda-suave)" },
  destinosTitulo: { display: "block", fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
                    textTransform: "uppercase", color: "var(--rv-texto-fraco)", marginBottom: 7 },
  destinosLista: { listStyle: "none", margin: 0, padding: 0, display: "flex",
                   flexDirection: "column", gap: 5 },
  destinoItem: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, flexWrap: "wrap" },
  destinoPonto: { width: 8, height: 8, borderRadius: 3, flex: "0 0 auto" },
  destinoRotulo: { color: "var(--rv-texto-suave)", flex: "1 1 auto", minWidth: 0 },
  destinoValor: { fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  destinoSaldo: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  aviso: { fontSize: 12, color: "var(--rv-ambar-texto)", lineHeight: 1.55, margin: "10px 0 0" },
  rodape: { fontSize: 11.5, color: "var(--rv-texto-fraco)", lineHeight: 1.55, margin: "10px 0 0" },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", marginBottom: 12 },
  erro: { fontSize: 12.5, color: "var(--rv-vermelho-texto)", lineHeight: 1.5, marginBottom: 12 },
};
