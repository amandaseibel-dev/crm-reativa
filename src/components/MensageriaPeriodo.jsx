// ===========================================================================
// VISÃO MENSAGERIA DA CENTRAL — conversas da equipe Reativa no período.
//
// LÊ SÓ O POSTGRES: `ulbra_central_conversas` (período; recorte no banco) e as
// respostas aguardando que a Central já recebe de `ulbra_central_operador`.
// Nenhuma chamada à ULBRA sai daqui.
//
// ORDEM, POR DECISÃO DA GESTÃO (11/11/2026):
//   1. respostas de alunos aguardando atendimento — da mais ANTIGA para a mais
//      recente (quem espera há mais tempo primeiro);
//   2. demais conversas do período — atividade mais RECENTE primeiro, com a
//      direção da última mensagem (recebida do aluno / enviada pela equipe).
// "Abrir ficha" só com vínculo confirmado por CPF (`aluno_id`). O que não tem
// CPF confirmado não chega aqui: a gestão vê só a contagem e trata na
// conferência do CRM ULBRA. Histórico completo e resposta pelo CRM NÃO estão
// disponíveis nesta etapa, e a tela diz isso.
// ===========================================================================
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../services/supabase";
import { fmtDataHora, fmtEspera, hrefFicha, nomeCurto, rotuloPeriodo } from "../utils/ulbraCentral";

const TAMANHO = 100;

function Selo({ tom = "cinza", children }) {
  return <span className={`ulbra-etiqueta ulbra-etiqueta--${tom || "cinza"}`}>{children}</span>;
}

function Ficha({ alunoId, aoAbrirFicha }) {
  return alunoId ? (
    <Link className="ulbra-link" to={hrefFicha(alunoId)} onClick={aoAbrirFicha}>Abrir ficha</Link>
  ) : (
    <span className="ulbra-texto-desativado">sem vínculo confirmado por CPF — ficha não abre</span>
  );
}

function ehFuncaoAusente(error) {
  return error?.code === "42883" || error?.code === "PGRST202" || /ulbra_central_conversas/.test(error?.message || "");
}

export default function MensageriaPeriodo({ ehGestao = false, operador = "", respostas = [], aoAbrirFicha }) {
  const [situacao, setSituacao] = useState("carregando"); // carregando | pronto | indisponivel | negado | erro
  const [erro, setErro] = useState(null);
  const [cabecalho, setCabecalho] = useState(null);
  const [linhas, setLinhas] = useState([]);
  // Página pedida junto com o operador a que ela pertence: trocar o operador no
  // filtro volta à página 0 sem precisar de efeito que zere estado.
  const [pedido, setPedido] = useState({ operador: null, pagina: 0 });
  const operadorPedido = ehGestao ? operador || null : null;
  const pagina = pedido.operador === operadorPedido ? pedido.pagina : 0;

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("ulbra_central_conversas", {
        p_desde: null,
        p_operador: operadorPedido,
        p_limite: TAMANHO,
        p_pagina: pagina,
      });
      if (!ativo) return;
      if (error) {
        if (ehFuncaoAusente(error)) setSituacao("indisponivel");
        else { setErro(error.message || "falha ao ler as conversas"); setSituacao("erro"); }
        return;
      }
      if (!data?.ok) {
        setSituacao(data?.motivo === "ACESSO_NEGADO" ? "negado" : "erro");
        if (data?.motivo && data.motivo !== "ACESSO_NEGADO") setErro(data.motivo);
        return;
      }
      setCabecalho(data);
      setLinhas((atual) => {
        const vistas = new Set(atual.map((c) => c.conversa_id));
        const novas = (data.conversas || []).filter((c) => !vistas.has(c.conversa_id));
        return pagina === 0 ? data.conversas || [] : [...atual, ...novas];
      });
      setSituacao("pronto");
    })();
    return () => { ativo = false; };
  }, [operadorPedido, pagina]);

  const totais = cabecalho?.totais || {};
  const demais = linhas.filter((c) => !c.aguardando);
  const temMais = typeof totais.conversas === "number" && linhas.length < totais.conversas;
  const periodo = rotuloPeriodo(cabecalho?.desde);

  return (
    <div data-testid="visao-mensageria">
      <p className="ulbra-aviso ulbra-aviso--cinza" data-testid="mensageria-limites">
        <strong>Mensageria ULBRA · equipe Reativa · {periodo}.</strong> Só o que a última coleta trouxe e só
        alunos com CPF confirmado. <strong>Histórico completo e resposta pelo CRM ainda não estão disponíveis:</strong>{" "}
        responder ao aluno é na Mensageria ULBRA; aqui você vê, abre a ficha e registra.
      </p>

      <section className="ulbra-bloco" data-testid="mensageria-aguardando">
        <h2 className="ulbra-bloco-titulo">
          1. Respostas de alunos aguardando atendimento <span className="ulbra-bloco-sub">{respostas.length} · mais antiga primeiro</span>
        </h2>
        {respostas.length === 0 ? (
          <p className="ulbra-bloco-vazio">nenhuma resposta aguardando</p>
        ) : (
          <ul className="ulbra-lista">
            {respostas.map((r) => (
              <li key={r.conversa_id} className="ulbra-linha" data-conversa={r.conversa_id}>
                <div className="ulbra-linha-topo">
                  <span className="ulbra-linha-nome">{r.nome || "sem nome"}</span>
                  <Selo tom="verde">recebida do aluno</Selo>
                  <span className="ulbra-linha-tempo">esperando {fmtEspera(r.espera_min)}</span>
                </div>
                {r.previa ? <div className="ulbra-linha-previa">“{r.previa}”</div> : null}
                <div className="ulbra-linha-meta">
                  <span>atendente na Mensageria: <strong>{r.atendente_ulbra || "não informado"}</strong></span>
                  <span>responsável no ReATIVA: <strong>{nomeCurto(r.responsavel_reativa) || (r.responsabilidade === "A_DEFINIR" ? "a definir" : "ninguém")}</strong></span>
                  <Ficha alunoId={r.aluno_id} aoAbrirFicha={aoAbrirFicha} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ulbra-bloco" data-testid="mensageria-conversas">
        <h2 className="ulbra-bloco-titulo">
          2. Demais conversas da equipe no período{" "}
          <span className="ulbra-bloco-sub">
            {situacao === "pronto" ? `${demais.length} de ${Math.max(0, (totais.conversas || 0) - (totais.aguardando || 0))}` : ""} · atividade mais recente primeiro
          </span>
        </h2>
        {situacao === "carregando" ? <p className="ulbra-bloco-vazio">carregando…</p> : null}
        {situacao === "indisponivel" ? (
          <p className="ulbra-aviso ulbra-aviso--cinza" data-testid="mensageria-indisponivel">
            Conversas do período ainda não disponíveis nesta etapa (consulta do banco não aplicada). Isto não significa que não há conversas.
          </p>
        ) : null}
        {situacao === "negado" ? <p className="ulbra-aviso ulbra-aviso--cinza">Sem acesso a esta lista.</p> : null}
        {situacao === "erro" ? <p className="ulbra-aviso ulbra-aviso--vermelho" role="alert">Não foi possível ler as conversas: {erro}</p> : null}
        {situacao === "pronto" && ehGestao && (totais.sem_cpf || 0) > 0 ? (
          <p className="ulbra-aviso ulbra-aviso--ambar" data-testid="mensageria-sem-cpf">
            {totais.sem_cpf} conversa{totais.sem_cpf === 1 ? "" : "s"} do período sem CPF confirmado não aparece{totais.sem_cpf === 1 ? "" : "m"} aqui:
            ficam na conferência da gestão (CRM ULBRA).
          </p>
        ) : null}
        {situacao === "pronto" && demais.length === 0 ? <p className="ulbra-bloco-vazio">nenhuma outra conversa no período</p> : null}
        {demais.length > 0 ? (
          <ul className="ulbra-lista">
            {demais.map((c) => (
              <li key={c.conversa_id} className="ulbra-linha" data-conversa={c.conversa_id} data-direcao={c.direcao}>
                <div className="ulbra-linha-topo">
                  <span className="ulbra-linha-nome">{c.nome || "sem nome"}</span>
                  {c.direcao === "recebida" ? <Selo tom="verde">recebida do aluno</Selo> : <Selo tom="cinza">enviada pela equipe</Selo>}
                  <span className="ulbra-linha-tempo">{fmtDataHora(c.mensagem_em)}</span>
                </div>
                {c.previa ? <div className="ulbra-linha-previa">“{c.previa}”</div> : null}
                <div className="ulbra-linha-meta">
                  <span>atendente na Mensageria: <strong>{c.atendente_ulbra || "não informado"}</strong></span>
                  <span>responsável no ReATIVA: <strong>{nomeCurto(c.responsavel_reativa) || (c.responsabilidade === "A_DEFINIR" ? "a definir" : "ninguém")}</strong></span>
                  <Ficha alunoId={c.aluno_id} aoAbrirFicha={aoAbrirFicha} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {situacao === "pronto" && temMais ? (
          <button type="button" className="ulbra-botao" onClick={() => setPedido({ operador: operadorPedido, pagina: pagina + 1 })}>Carregar mais conversas</button>
        ) : null}
      </section>
    </div>
  );
}
