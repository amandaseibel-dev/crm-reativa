import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { SeisLinhas, AlunosPorStatus } from "./SituacoesDaSafra";
import { S, moeda, num, dataCurta } from "./situacoesDaSafraFormato";

// EFETIVIDADE 2026/2 POR MÊS DE VENCIMENTO — um cartão por mês.
//
// Nenhuma conta acontece aqui. Quem soma é `carteira_2026_2_por_vencimento()`,
// que por sua vez só agrega o classificador 2026/2 já existente. O front
// desenha o que recebe e não recompõe situação nenhuma.
//
// As seis linhas do cartão e por que Pendente fica à parte estão na própria
// migration da RPC; na tela isso aparece no rodapé, em português de gestão.
//
// O DESENHO das seis linhas mora em `SituacoesDaSafra.jsx` desde 05/10/2026,
// quando a gestão pediu o mesmo cartão em 2024, 2025 e 2026/1. Aqui ficou só o
// que é de 2026/2: a RPC, o mês por extenso e os rodapés de rateio. Os testes
// deste arquivo valem como rede de segurança do arquivo compartilhado.

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
               "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function mesPorExtenso(competencia) {
  if (!competencia) return "—";
  const d = new Date(competencia.slice(0, 10) + "T12:00:00");
  const nome = MESES[d.getMonth()];
  return nome.charAt(0).toUpperCase() + nome.slice(1) + " de " + d.getFullYear();
}


export default function EfetividadePorVencimento() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("carteira_2026_2_por_vencimento");
      if (!ativo) return;
      if (error) setErro(error.message); else setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <p style={S.discreto}>Somando por mês de vencimento…</p>;
  if (erro) return <p style={S.erro}>Não foi possível carregar a visão por vencimento: {erro}</p>;

  const meses = dados?.meses || [];
  if (!meses.length) return <p style={S.discreto}>Sem títulos de 2026/2.</p>;

  const total = dados?.total?.situacoes || {};
  const conferencia = dados?.conferencia || {};
  const fichas = Number(dados?.total?.fichas || 0);
  const cpfs = Number(dados?.total?.cpfs || 0);
  const naoFecha = Number(conferencia.meses_que_nao_fecham || 0) > 0;

  return (
    <section>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Por mês de vencimento</h2>
        <span style={S.apoio}>
          {meses.length} {meses.length === 1 ? "mês" : "meses"} · vencimentos de{" "}
          {dataCurta(dados?.total?.vencimento_de)} a {dataCurta(dados?.total?.vencimento_ate)}
        </span>
      </div>

      {/* A invariante é medida a cada chamada. Enquanto fecha, a tela diz isso
          em uma linha; se um dia não fechar, o aviso sobe em vermelho e nenhum
          número é corrigido por conta própria. */}
      {naoFecha ? (
        <p style={S.erro}>
          ⚠️ {num(conferencia.meses_que_nao_fecham)}{" "}
          {Number(conferencia.meses_que_nao_fecham) === 1 ? "mês não fecha" : "meses não fecham"}: a soma das
          situações difere de Entrou em {moeda(conferencia.diferenca_total)}. Os números abaixo estão como vieram
          do classificador — nada foi ajustado para fechar.
        </p>
      ) : null}

      <div style={S.grade}>
        {meses.map((m) => (
          <Cartao key={m.competencia} mes={m} />
        ))}
      </div>

      <div style={{ ...S.cartao, marginTop: 16 }}>
        <div style={S.cartaoTopo}>
          <strong style={S.mesNome}>Todos os meses</strong>
          <span style={S.mesApoio}>2026/2 inteiro</span>
        </div>
        <SeisLinhas s={total} composicao={dados?.pago_composicao} />
      </div>

      <p style={S.rodape}>
        <strong>O que é “atribuído diretamente” e o que é “por rateio”.</strong> Atribuído diretamente é baixa
        no próprio título, ou acordo que cobre um título só — nos dois casos o dinheiro é daquele título. Por
        rateio é acordo que cobre mais de um título: o valor é dividido entre eles pela proporção de parcelas
        pagas do acordo, que é o critério já existente no CRM. Como um acordo pode cobrir títulos de meses
        diferentes, essa parte do Pago pode ter vindo do mês vizinho. Os dois somam o Pago do mês.
      </p>
      {fichas && cpfs && fichas !== cpfs ? (
        <p style={S.rodape}>
          <strong>Duas unidades de contagem, as duas corretas.</strong> Os cartões contam{" "}
          <strong>fichas do CRM</strong> ({num(fichas)}), que é o registro que a operação trabalha. A linha
          “Carteira recebida”, acima, conta <strong>CPFs únicos</strong> ({num(cpfs)}). A diferença são CPFs
          com mais de uma ficha — não é divergência de cálculo, e nenhum cadastro foi alterado para os dois
          números coincidirem.
        </p>
      ) : null}
      <p style={S.rodape}>
        <strong>Um aluno pode aparecer em mais de uma situação</strong> — basta ter títulos em situações
        diferentes, no mesmo mês ou em meses diferentes. As contagens de alunos{" "}
        <strong>não devem ser somadas</strong>: nem entre situações, nem entre meses. Só títulos e valores somam.
      </p>
      <p style={S.rodape}>
        <strong>Saldo:</strong> {dados?.saldo_metodo}
      </p>
      <p style={S.rodape}>
        Situação do Prime coletada em {dataCurta(dados?.atualizado_em?.prime_coletado_em)} · último movimento em
        título em {dataCurta(dados?.atualizado_em?.titulo_mexido_em)}.
      </p>
    </section>
  );
}

function Cartao({ mes }) {
  const de = dataCurta(mes.vencimento_de), ate = dataCurta(mes.vencimento_ate);
  return (
    <div style={S.cartao}>
      <div style={S.cartaoTopo}>
        <strong style={S.mesNome}>{mesPorExtenso(mes.competencia)}</strong>
        <span style={S.mesApoio}>
          {de === ate ? "vence em " + de : "vence de " + de + " a " + ate}
          {Number(mes.datas_de_vencimento) > 1 ? " · " + num(mes.datas_de_vencimento) + " datas" : ""}
        </span>
      </div>
      <SeisLinhas s={mes.situacoes || {}} composicao={mes.pago_composicao} />
      <AlunosPorStatus lista={mes.status || []} />
    </div>
  );
}
