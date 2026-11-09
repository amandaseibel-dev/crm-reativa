// ===========================================================================
// CRM ULBRA — painel compacto da gestão sobre o espelho da Mensageria.
//
// LÊ SÓ O POSTGRES, por uma RPC de agregação (`ulbra_painel_gestao`). Nenhuma
// chamada à ULBRA sai daqui: "Atualizar painel" relê o banco, não a Mensageria.
// Os indicadores saem de `count`/`group by` no banco, sobre o espelho inteiro.
//
// REGRAS QUE ESTA TELA NÃO NEGOCIA
//   - indicador sem dado aparece como "não disponível", nunca zero/estimativa;
//   - zero, desatualizado, erro, pulado por orçamento e coleta incompleta são
//     estados DIFERENTES; "automática" só com cron de fato ativo;
//   - responsável NO REATIVA ≠ atendente NA MENSAGERIA: dois sistemas, dois
//     campos; "sem responsável no ReATIVA" não é pendência operacional enquanto
//     `assumir` estiver bloqueado no piloto -- fica nos detalhes, não em cartão;
//   - o espelho é PARCIAL por construção: uma nota diz que os números são do
//     espelho coletado, não o total da Mensageria;
//   - em "Pendências de conferência" NÃO se mostra "mais antigo esperando": o
//     agregado `espera` da RPC é sobre atendimentos sem responsável no ReATIVA,
//     outro universo. Sem medida específica, o dado é omitido, não aproximado.
// ===========================================================================
import { useCallback, useState } from "react";
import "./ulbra.css";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { normalizarEmail } from "../utils/ulbraRecebimento";
import { ND, descreverEstado, estadoExigeAviso, fmtHora, fmtMin, fmtNum, rotuloFaixa } from "../utils/ulbraPainel";

// Releitura de reserva do Postgres (não da ULBRA), para a aba deixada aberta.
const POLL_MS = 60_000;

const TOM = {
  verde: "ulbra-aviso--verde",
  ambar: "ulbra-aviso--ambar",
  vermelho: "ulbra-aviso--vermelho",
  cinza: "ulbra-aviso--cinza",
};

export default function PainelMensageriaUlbra({ usuario }) {
  const email = normalizarEmail(usuario?.perfil?.email || usuario?.auth?.email);
  const [dados, setDados] = useState(null);
  const [situacao, setSituacao] = useState("carregando"); // carregando | pronto | negado | indisponivel | erro
  const [erro, setErro] = useState(null);

  const buscar = useCallback(async () => {
    const { data, error } = await supabase.rpc("ulbra_painel_gestao");
    if (error) {
      // 42883 = função inexistente: a migration do painel não foi aplicada.
      if (error.code === "42883" || /ulbra_painel_gestao/.test(error.message || "")) {
        setSituacao("indisponivel");
      } else {
        setErro(error.message || "falha ao ler o painel");
        setSituacao("erro");
      }
      return;
    }
    if (!data?.ok) {
      setSituacao(data?.motivo === "ACESSO_NEGADO" ? "negado" : "erro");
      if (data?.motivo && data.motivo !== "ACESSO_NEGADO") setErro(data.motivo);
      return;
    }
    setDados(data);
    setSituacao("pronto");
  }, []);

  const atualizarAgora = usePolling(buscar, POLL_MS, [email], Boolean(email));

  if (!email || situacao === "negado") {
    return <div className="ulbra-pagina">Esta tela é restrita à gestão.</div>;
  }
  if (situacao === "indisponivel") {
    return (
      <div className="ulbra-pagina">
        <h1 className="ulbra-titulo">CRM ULBRA</h1>
        <div className="ulbra-aviso ulbra-aviso--cinza">
          <strong>Painel não disponível.</strong> A função de agregação (<code>ulbra_painel_gestao</code>) ainda não
          foi aplicada no banco. Nenhum número é mostrado no lugar.
        </div>
      </div>
    );
  }
  if (situacao === "erro") {
    return (
      <div className="ulbra-pagina">
        <h1 className="ulbra-titulo">CRM ULBRA</h1>
        <div className="ulbra-aviso ulbra-aviso--vermelho">
          <strong>Erro ao ler o painel:</strong> {erro || ND}. Nenhum número é mostrado no lugar.
        </div>
        <button type="button" onClick={() => atualizarAgora()} className="ulbra-link" style={{ marginTop: 10 }}>
          tentar de novo
        </button>
      </div>
    );
  }
  if (situacao === "carregando" || !dados) {
    return <div className="ulbra-pagina ulbra-texto-desativado">Lendo o espelho…</div>;
  }

  const { sync = {}, conversas = {}, atendimentos = {}, espera = {}, cobertura = {} } = dados;
  const est = descreverEstado(dados);
  const manual = dados.atualizacao !== "automatica";
  const aviso = estadoExigeAviso(dados.estado);
  const porAtendente = Object.entries(conversas.por_atendente_ulbra || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="ulbra-pagina">
      {/* CABEÇALHO: título, faixa de estado, botão */}
      <div className="ulbra-cabecalho">
        <div>
          <h1 className="ulbra-titulo">CRM ULBRA</h1>
          <div
            className={`ulbra-faixa ${aviso ? "ulbra-faixa--aviso" : ""}`}
            data-testid="faixa-estado"
            data-estado={dados.estado}
            data-atualizacao={manual ? "manual" : "automatica"}
          >
            {manual ? "Atualização manual" : "Atualização automática"} • última coleta em {fmtHora(sync.ultima_execucao)} • {rotuloFaixa(dados)}
          </div>
        </div>
        <div>
          <button type="button" onClick={() => atualizarAgora()} className="ulbra-botao">
            Atualizar painel
          </button>
          <div className="ulbra-ajuda">
            Atualiza a leitura dos dados já coletados. Não consulta a ULBRA.
          </div>
        </div>
      </div>

      {/* AVISO RESUMIDO fora dos detalhes, só quando há falha/incompleto */}
      {aviso ? (
        <div className={`ulbra-aviso ${TOM[est.tom]}`} data-testid="aviso-estado" data-estado={dados.estado}>
          <span style={{ fontWeight: 600 }}>{est.titulo}</span>
          {est.texto ? <span> — {est.texto}</span> : null}
        </div>
      ) : null}

      <p className="ulbra-nota" data-testid="nota-espelho">
        Números do espelho coletado pelo ReATIVA (equipe {cobertura.equipe || ND}, {listaCanais(cobertura.canais_coletados)}), não o total da Mensageria.
      </p>

      {/* QUATRO CARTÕES */}
      <section className="ulbra-cartoes" data-testid="cartoes">
        <Cartao n={fmtNum(atendimentos.coletados)} titulo="atendimentos coletados" sub="atendimentos em espera, no espelho" />
        <Cartao n={fmtNum(conversas.resposta_aguardando)} titulo="conversas aguardando resposta" sub="conversas cuja última mensagem é do aluno" />
        <Cartao n={fmtNum(atendimentos.em_conferencia)} titulo="atendimentos em conferência" sub="identidade não confirmada por CPF" destaque={atendimentos.em_conferencia > 0} />
        <Cartao n={fmtNum(conversas.sem_atendente_ulbra)} titulo="conversas sem atendente na Mensageria" sub="como a Mensageria informa" />
      </section>

      {/* CONVERSAS POR ATENDENTE NA MENSAGERIA */}
      <section className="ulbra-bloco" data-testid="por-atendente">
        <div className="ulbra-bloco-titulo">Conversas por atendente na Mensageria</div>
        <div className="ulbra-bloco-sub">Nome como a Mensageria informa. Não é correspondência com operador do ReATIVA.</div>
        {conversas.por_atendente_ulbra == null ? (
          <div className="ulbra-bloco-vazio">{ND}</div>
        ) : (
          <table className="ulbra-tabela">
            <thead>
              <tr>
                <th>atendente na Mensageria</th>
                <th className="ulbra-num">conversas</th>
              </tr>
            </thead>
            <tbody>
              {porAtendente.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="ulbra-num">{v}</td>
                </tr>
              ))}
              <tr style={{ color: "var(--rv-texto-suave)" }}>
                <td>sem atendente informado</td>
                <td className="ulbra-num">{fmtNum(conversas.sem_atendente_ulbra)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* PENDÊNCIAS DE CONFERÊNCIA — só o que a RPC mede sobre esse universo */}
      <section className="ulbra-bloco" data-testid="conferencia">
        <div className="ulbra-bloco-titulo">
          <span>Pendências de conferência</span>
          <span className="ulbra-etiqueta ulbra-etiqueta--cinza">{fmtNum(atendimentos.em_conferencia)} atendimentos</span>
        </div>
        <div className="ulbra-bloco-sub">
          Clientes sem vínculo confirmado por CPF. A identidade nunca é presumida por nome ou telefone; a conferência é da gestão, na ficha do aluno.
        </div>
        <dl className="ulbra-dupla">
          <Dt k="identidade confirmada (conversas)" v={fmtNum(conversas.identidade_confirmada)} />
          <Dt k="identidade não confirmada (conversas)" v={fmtNum(conversas.identidade_nao_confirmada)} />
        </dl>
      </section>

      {/* DETALHES DA SINCRONIZAÇÃO — recolhido por padrão */}
      <details className="ulbra-detalhes" data-testid="detalhes">
        <summary>Detalhes da sincronização</summary>
        <div className="ulbra-detalhes-corpo">
          <div className={`ulbra-aviso ${TOM[est.tom]}`} data-testid="bloco-estado" data-estado={dados.estado}>
            <div style={{ fontWeight: 600 }}>{est.titulo}</div>
            {est.texto ? <div style={{ marginTop: 2 }}>{est.texto}</div> : null}
          </div>

          <Grupo titulo="Ciclo">
            <Dt k="atualização" v={manual ? "manual — sem sincronização automática ativa" : "automática (cron ativo)"} />
            <Dt k="último ciclo" v={fmtHora(sync.ultima_execucao)} />
            <Dt k="atraso" v={fmtMin(sync.atraso_min)} />
            <Dt k="resultado" v={sync.ultimo_ciclo ? `${sync.ultimo_ciclo}${sync.ultimo_erro ? ` · ${sync.ultimo_erro}` : ""}` : ND} />
            <Dt k="cursor" v={sync.cursor_mensagem ? fmtHora(sync.cursor_mensagem) : "não avançou (ciclo incompleto ou sem ciclo)"} />
            <Dt k="piso guardado" v={fmtHora(sync.piso_pendente)} />
            <Dt k="backlog (fila de detalhes)" v={fmtNum(sync.detalhe_fila_tamanho)} />
            <Dt k="pendências abertas" v={fmtNum(sync.detalhes_pendencias_abertas)} />
            <Dt k="chamadas no dia" v={fmtNum(sync.chamadas_dia)} />
            <Dt k="saldo da pessoa do token" v={sync.saldo_api_restam != null ? `${sync.saldo_api_restam} de 500 — fotografia de ${fmtHora(sync.saldo_api_em)}, não saldo final` : ND} />
            {sync.alerta_gestao ? <Dt k="alerta" v={sync.alerta_gestao} /> : null}
          </Grupo>

          <Grupo titulo="Cobertura — o que foi coletado, não o total da Mensageria" testid="cobertura">
            <Dt k="equipe" v={cobertura.equipe || ND} />
            <Dt k="canais coletados" v={lista(cobertura.canais_coletados)} />
            <Dt k="canais ativos na coleta" v="WhatsApp (e-mail: não ativo)" />
            <Dt k="situações coletadas" v={lista(cobertura.situacoes_coletadas)} />
            <Dt k="período das conversas" v={periodo(cobertura.periodo?.conversas_de, cobertura.periodo?.conversas_ate)} />
            <Dt k="período dos atendimentos" v={periodo(cobertura.periodo?.atendimentos_de, cobertura.periodo?.atendimentos_ate)} />
            <Dt k="primeira coleta" v={fmtHora(cobertura.periodo?.primeira_coleta)} />
            <Dt k="última coleta" v={fmtHora(cobertura.periodo?.ultima_coleta)} />
            <Dt k="conversas por canal" v={objeto(conversas.por_canal)} />
            <Dt k="conversas por situação" v={objeto(conversas.por_situacao)} />
            <Dt k="atendimentos por situação" v={objeto(atendimentos.por_situacao)} />
            <Dt k="destino sugerido (não é posse)" v={objeto(atendimentos.por_destino_sugerido)} />
          </Grupo>

          <Grupo titulo="Tempos de espera">
            <Dt k="universo" v={espera.universo || ND} />
            <Dt k="contado desde" v={espera.base || ND} />
            <Dt k="na conta" v={fmtNum(espera.n)} />
            <Dt k="sem data de entrada (fora da conta)" v={fmtNum(espera.sem_data)} />
            <Dt k="maior espera" v={fmtMin(espera.max_min)} />
            <Dt k="mediana" v={fmtMin(espera.mediana_min)} />
            <Dt k="acima de 30 min" v={fmtNum(espera.acima_30_min)} />
            <Dt k="resposta de aluno mais antiga aguardando" v={conversas.resposta_mais_antiga_em ? `${fmtHora(conversas.resposta_mais_antiga_em)} (${fmtMin(conversas.espera_resposta_max_min)})` : ND} />
            <Dt k="não lidas por você" v={`${fmtNum(conversas.nao_lidas_para_mim)} (marcador é por pessoa)`} />
          </Grupo>

          <Grupo titulo="Responsável no ReATIVA (posse por quem assumiu aqui)">
            <Dt k="assumidos" v={fmtNum(atendimentos.com_responsavel_reativa)} />
            <Dt k="sem responsável no ReATIVA" v={`${fmtNum(atendimentos.sem_responsavel_reativa)} — assumir está bloqueado no piloto; não é pendência operacional`} />
            <Dt k="por responsável" v={objeto(atendimentos.por_responsavel_reativa)} />
          </Grupo>

          <Grupo titulo="Indicadores não disponíveis e do que dependem">
            <Dt k="atendimentos — atendente na Mensageria" v={atendimentos.atendente_ulbra == null ? `${ND} (o espelho de atendimentos não guarda esse campo)` : objeto(atendimentos.atendente_ulbra)} />
            <Dt k="atendimentos por canal" v={atendimentos.por_canal == null ? `${ND} (o espelho de atendimentos não guarda canal)` : objeto(atendimentos.por_canal)} />
            <Dt k="alcance do último ciclo (páginas)" v={cobertura.alcance_paginas == null ? `${ND} (páginas lidas ainda não são gravadas)` : String(cobertura.alcance_paginas)} />
            <Dt k="divergência carteira ReATIVA × atendente ULBRA" v={`${ND} — depende do mapeamento de operadores; não se calcula por nome`} />
          </Grupo>

          <div className="ulbra-rodape">
            Mensagem ≠ conversa ≠ atendimento ≠ aluno único. "Sem responsável no ReATIVA" não prova nada sobre o atendente na ULBRA: são dois sistemas, dois campos.
          </div>
        </div>
      </details>
    </div>
  );
}

function Cartao({ n, titulo, sub, destaque = false }) {
  return (
    <div className={`ulbra-cartao ${destaque ? "ulbra-cartao--destaque" : ""}`}>
      <div className="ulbra-cartao-numero">{n}</div>
      <div className="ulbra-cartao-titulo">{titulo}</div>
      <div className="ulbra-cartao-sub">{sub}</div>
    </div>
  );
}
function Grupo({ titulo, children, testid }) {
  return (
    <div className="ulbra-grupo" data-testid={testid}>
      <div className="ulbra-grupo-titulo">{titulo}</div>
      <dl className="ulbra-lista">{children}</dl>
    </div>
  );
}
function Dt({ k, v }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
function objeto(o) {
  if (o == null) return ND;
  const e = Object.entries(o);
  return e.length === 0 ? "nenhum" : e.map(([k, v]) => `${k}: ${v}`).join(" · ");
}
function lista(a) {
  if (!Array.isArray(a)) return ND;
  return a.length === 0 ? "nenhum" : a.join(", ");
}
function listaCanais(a) {
  if (!Array.isArray(a) || a.length === 0) return "canais: " + ND;
  return a.map((c) => (c === "whatsapp" ? "WhatsApp" : c)).join(", ");
}
function periodo(de, ate) {
  if (!de && !ate) return ND;
  return `${fmtHora(de)} → ${fmtHora(ate)}`;
}
