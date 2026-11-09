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
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { normalizarEmail } from "../utils/ulbraRecebimento";
import { ND, descreverEstado, estadoExigeAviso, fmtHora, fmtMin, fmtNum, rotuloFaixa } from "../utils/ulbraPainel";

// Releitura de reserva do Postgres (não da ULBRA), para a aba deixada aberta.
const POLL_MS = 60_000;

const TOM = {
  verde: "border-emerald-300 bg-emerald-50 text-emerald-900",
  ambar: "border-amber-300 bg-amber-50 text-amber-900",
  vermelho: "border-red-400 bg-red-50 text-red-800",
  cinza: "border-gray-300 bg-gray-50 text-gray-800",
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
    return <div className="p-6 text-sm">Esta tela é restrita à gestão.</div>;
  }
  if (situacao === "indisponivel") {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-lg font-semibold">CRM ULBRA</h1>
        <div className="mt-3 rounded border border-gray-300 bg-gray-50 p-3 text-sm">
          <strong>Painel não disponível.</strong> A função de agregação (<code>ulbra_painel_gestao</code>) ainda não
          foi aplicada no banco. Nenhum número é mostrado no lugar.
        </div>
      </div>
    );
  }
  if (situacao === "erro") {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-lg font-semibold">CRM ULBRA</h1>
        <div className="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <strong>Erro ao ler o painel:</strong> {erro || ND}. Nenhum número é mostrado no lugar.
        </div>
        <button type="button" onClick={() => atualizarAgora()} className="mt-3 text-sm text-blue-700 hover:underline">
          tentar de novo
        </button>
      </div>
    );
  }
  if (situacao === "carregando" || !dados) {
    return <div className="p-6 text-sm text-gray-500">Lendo o espelho…</div>;
  }

  const { sync = {}, conversas = {}, atendimentos = {}, espera = {}, cobertura = {} } = dados;
  const est = descreverEstado(dados);
  const manual = dados.atualizacao !== "automatica";
  const aviso = estadoExigeAviso(dados.estado);
  const porAtendente = Object.entries(conversas.por_atendente_ulbra || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto text-gray-900">
      {/* CABEÇALHO: título, faixa de estado, botão */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">CRM ULBRA</h1>
          <div
            className={`mt-1 text-xs ${aviso ? "text-amber-800" : "text-gray-600"}`}
            data-testid="faixa-estado"
            data-estado={dados.estado}
            data-atualizacao={manual ? "manual" : "automatica"}
          >
            {manual ? "Atualização manual" : "Atualização automática"} • última coleta em {fmtHora(sync.ultima_execucao)} • {rotuloFaixa(dados)}
          </div>
        </div>
        <div className="text-left md:text-right">
          <button type="button" onClick={() => atualizarAgora()} className="text-sm px-3 py-1.5 rounded border bg-white hover:bg-gray-50">
            Atualizar painel
          </button>
          <div className="text-[11px] text-gray-500 mt-1 max-w-[260px]">
            Atualiza a leitura dos dados já coletados. Não consulta a ULBRA.
          </div>
        </div>
      </div>

      {/* AVISO RESUMIDO fora dos detalhes, só quando há falha/incompleto */}
      {aviso ? (
        <div className={`mt-3 rounded border p-2.5 text-xs ${TOM[est.tom]}`} data-testid="aviso-estado" data-estado={dados.estado}>
          <span className="font-semibold">{est.titulo}</span>
          {est.texto ? <span> — {est.texto}</span> : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-gray-500" data-testid="nota-espelho">
        Números do espelho coletado pelo ReATIVA (equipe {cobertura.equipe || ND}, {listaCanais(cobertura.canais_coletados)}), não o total da Mensageria.
      </p>

      {/* QUATRO CARTÕES */}
      <section className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="cartoes">
        <Cartao n={fmtNum(atendimentos.coletados)} titulo="atendimentos coletados" sub="atendimentos em espera, no espelho" />
        <Cartao n={fmtNum(conversas.resposta_aguardando)} titulo="conversas aguardando resposta" sub="conversas cuja última mensagem é do aluno" />
        <Cartao n={fmtNum(atendimentos.em_conferencia)} titulo="atendimentos em conferência" sub="identidade não confirmada por CPF" destaque={atendimentos.em_conferencia > 0} />
        <Cartao n={fmtNum(conversas.sem_atendente_ulbra)} titulo="conversas sem atendente na Mensageria" sub="como a Mensageria informa" />
      </section>

      {/* CONVERSAS POR ATENDENTE NA MENSAGERIA */}
      <section className="mt-4 rounded border bg-white p-3 text-sm" data-testid="por-atendente">
        <div className="font-semibold">Conversas por atendente na Mensageria</div>
        <div className="text-xs text-gray-500 mt-0.5">Nome como a Mensageria informa. Não é correspondência com operador do ReATIVA.</div>
        {conversas.por_atendente_ulbra == null ? (
          <div className="mt-2 text-xs text-gray-500">{ND}</div>
        ) : (
          <table className="w-full mt-2 text-xs">
            <thead>
              <tr className="text-gray-500 border-b">
                <th className="text-left font-medium py-1">atendente na Mensageria</th>
                <th className="text-right font-medium py-1">conversas</th>
              </tr>
            </thead>
            <tbody>
              {porAtendente.map(([k, v]) => (
                <tr key={k} className="border-b">
                  <td className="py-1.5 pr-2 break-all">{k}</td>
                  <td className="py-1.5 text-right tabular-nums">{v}</td>
                </tr>
              ))}
              <tr className="border-b text-gray-500">
                <td className="py-1.5 pr-2">sem atendente informado</td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(conversas.sem_atendente_ulbra)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* PENDÊNCIAS DE CONFERÊNCIA — só o que a RPC mede sobre esse universo */}
      <section className="mt-4 rounded border bg-white p-3 text-sm" data-testid="conferencia">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Pendências de conferência</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 tabular-nums">{fmtNum(atendimentos.em_conferencia)} atendimentos</span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Clientes sem vínculo confirmado por CPF. A identidade nunca é presumida por nome ou telefone; a conferência é da gestão, na ficha do aluno.
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Dt k="identidade confirmada (conversas)" v={fmtNum(conversas.identidade_confirmada)} />
          <Dt k="identidade não confirmada (conversas)" v={fmtNum(conversas.identidade_nao_confirmada)} />
        </dl>
      </section>

      {/* DETALHES DA SINCRONIZAÇÃO — recolhido por padrão */}
      <details className="mt-4 rounded border bg-white text-sm" data-testid="detalhes">
        <summary className="cursor-pointer px-3 py-2 font-semibold select-none">Detalhes da sincronização</summary>
        <div className="px-3 pb-3 text-xs">
          <div className={`rounded border p-2 ${TOM[est.tom]}`} data-testid="bloco-estado" data-estado={dados.estado}>
            <div className="font-semibold">{est.titulo}</div>
            {est.texto ? <div className="mt-0.5">{est.texto}</div> : null}
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

          <div className="mt-3 text-gray-500">
            Mensagem ≠ conversa ≠ atendimento ≠ aluno único. "Sem responsável no ReATIVA" não prova nada sobre o atendente na ULBRA: são dois sistemas, dois campos.
          </div>
        </div>
      </details>
    </div>
  );
}

function Cartao({ n, titulo, sub, destaque = false }) {
  return (
    <div className={`rounded border bg-white p-3 ${destaque ? "border-amber-400" : ""}`}>
      <div className="text-2xl font-semibold tabular-nums leading-none">{n}</div>
      <div className="text-sm mt-2 leading-tight">{titulo}</div>
      <div className="text-[11px] text-gray-500 mt-0.5 leading-tight">{sub}</div>
    </div>
  );
}
function Grupo({ titulo, children, testid }) {
  return (
    <div className="mt-3" data-testid={testid}>
      <div className="font-semibold text-gray-700">{titulo}</div>
      <dl className="mt-1 grid grid-cols-1 md:grid-cols-[max-content_1fr] gap-x-4 gap-y-1">{children}</dl>
    </div>
  );
}
function Dt({ k, v }) {
  return (
    <>
      <dt className="text-gray-500">{k}</dt>
      <dd className="font-medium break-words">{v}</dd>
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
