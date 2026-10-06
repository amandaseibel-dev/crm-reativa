import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { SeisLinhas, AlunosPorStatus, AvisoConferencia } from "./SituacoesDaSafra";
import { S, moeda, num, dataCurta } from "./situacoesDaSafraFormato";

// AS SEIS LINHAS EM 2024, 2025 E 2026/1 — o mesmo cartão que 2026/2 já tinha.
//
// Pedido da gestão em 05/10/2026: Entrou, Pago, Negociado, Cancelado, Em aberto
// e Pendente, no mesmo desenho, em qualquer safra. O desenho vem de
// `SituacoesDaSafra.jsx`; os números vêm de `carteira_safra_situacoes(ano, sem)`
// e os status acadêmicos de `carteira_academico_perfil(ano, sem)`.
//
// Nenhuma conta acontece aqui — nem a do percentual, que é share sobre Entrou e
// é calculado no desenho compartilhado, nem a invariante, que vem conferida do
// banco em `conferencia` e é só exibida.
//
// POR QUE OS STATUS VÊM DA IMPORTAÇÃO, E NÃO DE `grupos`. A RPC devolve dois
// blocos: `grupos`, que é a consulta viva ao Prime, e `importacao.situacoes`,
// que é a situação acadêmica do relatório importado. Medido em 05/10/2026:
// `grupos` está 98,6% em "Ainda não consultados" em 2026/1 e tem 2 categorias
// em 2024 — não serve para a tela. `importacao.situacoes` tem as categorias
// reais (Formado, Trancado, Cancelado, Término do Contrato, Desvinculado…) e
// fecha com o total de alunos nas três safras. A tela diz a data da importação,
// porque ela não é de hoje.

export default function SeisLinhasDaSafra({ ano, semestre = null }) {
  const [dados, setDados] = useState(null);
  const [perfil, setPerfil] = useState(null);
  // O erro do perfil é guardado À PARTE do erro das seis linhas: se a consulta
  // acadêmica falhar, as seis linhas continuam valendo e só o bloco de status
  // fica sem dado. Sem este estado a falha era ENGOLIDA -- `perfil` virava null
  // e "Alunos por status" sumia da tela sem dizer por quê, que é exatamente
  // como o bloco desapareceu em 2024/2025.
  const [erroPerfil, setErroPerfil] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    // O reset entra DENTRO da função assíncrona de propósito: setState no corpo
    // do efeito cascateia render e a regra `react-hooks/set-state-in-effect`
    // reprova na catraca do lint.
    (async () => {
      setCarregando(true);
      setErro("");
      setErroPerfil("");
      const [a, b] = await Promise.all([
        supabase.rpc("carteira_safra_situacoes", { p_ano: ano, p_semestre: semestre }),
        supabase.rpc("carteira_academico_perfil", { p_ano: ano, p_semestre: semestre }),
      ]);
      if (!ativo) return;
      if (a.error) setErro(a.error.message);
      setDados(a.data || null);
      setErroPerfil(b.error ? (b.error.message || "falha ao consultar") : "");
      setPerfil(b.error ? null : (b.data || null));
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [ano, semestre]);

  if (carregando) return <p style={S.discreto}>Somando as seis linhas de {rotulo(ano, semestre)}…</p>;
  if (erro) return <p style={S.erro}>Não foi possível carregar as seis linhas: {erro}</p>;

  const s = dados?.situacoes || {};
  if (!Object.keys(s).length) return <p style={S.discreto}>Sem títulos em {rotulo(ano, semestre)}.</p>;

  const conf = dados?.conferencia || null;
  const det = dados?.pendente_detalhe || {};
  const status = (perfil?.importacao?.situacoes || [])
    .map((x) => ({ status: x.situacao, alunos: x.alunos }));
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
        <SeisLinhas s={s} />
        {erroPerfil ? (
          <p style={{ ...S.rodape, color: "var(--rv-vermelho-texto)" }}>
            <strong>Alunos por status não carregou:</strong> {erroPerfil}. As seis linhas acima não dependem
            dessa consulta e seguem válidas.
          </p>
        ) : null}
        <AlunosPorStatus
          lista={status}
          rodape={perfil?.importacao?.atualizado_em
            ? "Situação acadêmica do relatório de inadimplência importado em "
              + dataCurta(perfil.importacao.atualizado_em) + ". Não é consulta de hoje ao Prime: "
              + "a consulta viva responde \"ainda não consultado\" para a quase totalidade destes alunos, "
              + "e por isso não é ela que alimenta esta lista."
            : null}
        />
      </div>

      {/* Pendente é o único total composto, então ele é aberto por dentro. */}
      {Number(s.pendente?.valor || 0) > 0 ? (
        <p style={S.rodape}>
          <strong>O que está em Pendente.</strong>{" "}
          {Number(det.convertido_origem_comprovada || 0) > 0 ? (
            <>{moeda(det.convertido_origem_comprovada)} é conversão com origem comprovada — sabemos que
            converteu, mas não se foi pagamento ou acordo, então não entra em Pago nem em Negociado.{" "}</>
          ) : null}
          {Number(det.em_validacao || 0) > 0 ? <>{moeda(det.em_validacao)} em validação.{" "}</> : null}
          {Number(det.ajuste_academico || 0) > 0 ? <>{moeda(det.ajuste_academico)} de ajuste acadêmico.{" "}</> : null}
          {Number(det.em_confirmacao || 0) > 0 ? <>{moeda(det.em_confirmacao)} em confirmação de pagamento.{" "}</> : null}
          {Number(det.pago_sem_lastro || 0) > 0 ? (
            <><strong>{moeda(det.pago_sem_lastro)} está marcado como PAGO sem lastro nenhum</strong>: sem
            acordo, sem pagamento casado pelo número do título e sem liquidação da Prime. O único vestígio é
            o campo de saldo estar abaixo do valor original, e esse campo não é saldo atualizado. Fica em
            Pendente em vez de Pago — chamar de Pago afirmaria dinheiro que ninguém viu entrar.{" "}</>
          ) : null}
        </p>
      ) : null}

      {historica ? (
        <p style={S.rodape}>
          <strong>“Entrou” aqui não é a carteira original de {ano}.</strong> O CRM não guarda nada anterior a
          julho/2026, então o que existe desta safra é o <strong>saldo residual</strong> que ainda estava
          aberto quando a operação começou. O percentual de cada linha é share sobre esse residual, não sobre
          a carteira que a instituição emitiu em {ano}.
        </p>
      ) : (
        <p style={S.rodape}>
          <strong>Números ao vivo.</strong> Esta safra é recalculada a cada abertura da tela, título a título,
          e não vem do snapshot de 11/09/2026 — por isso dois carregamentos no mesmo dia podem diferir se
          houver cobrança acontecendo no intervalo.
        </p>
      )}

      <p style={S.rodape}>
        <strong>Um aluno pode aparecer em mais de uma situação</strong> — basta ter títulos em situações
        diferentes. As contagens de alunos <strong>não devem ser somadas</strong> entre linhas; só títulos e
        valores somam.
      </p>
      {conf ? (
        <p style={S.rodape}>
          Conferência da invariante: Entrou {moeda(conf.entrou)} contra {moeda(conf.soma_das_linhas)} somados
          nas cinco linhas — diferença de {moeda(conf.diferenca)}. Medida a cada chamada; conta e registra,
          não corrige. Gerado em {dataCurta(dados?.gerado_em)}.
        </p>
      ) : null}
      {status.length ? (
        <p style={S.rodape}>
          {num(status.reduce((t, x) => t + Number(x.alunos || 0), 0))} alunos distribuídos em{" "}
          {num(status.length)} {status.length === 1 ? "categoria" : "categorias"} da base. As categorias são as
          que a base tem — não há “Evadido” entre elas.
        </p>
      ) : null}
    </section>
  );
}

function rotulo(ano, semestre) {
  return semestre ? ano + "/" + semestre : String(ano);
}
