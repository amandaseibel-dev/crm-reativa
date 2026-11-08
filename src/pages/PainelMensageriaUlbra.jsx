// ===========================================================================
// PAINEL GESTÃO DA MENSAGERIA ULBRA — confiabilidade antes dos números.
//
// LÊ SÓ O POSTGRES, por uma RPC de agregação (`ulbra_painel_gestao`). Nenhuma
// chamada à ULBRA sai daqui: abrir dez painéis custa zero na Mensageria. Os
// indicadores saem de `count`/`group by` no banco, sobre o espelho inteiro —
// não herdam o teto de 200 linhas do sino.
//
// REGRAS QUE ESTA TELA NÃO NEGOCIA
//   - indicador sem dado suficiente aparece como "não disponível", nunca zero
//     nem estimativa (canal de atendimento, alcance em páginas, divergência de
//     responsável — esta última depende do mapeamento, não se calcula por nome);
//   - "zero" e "dados desatualizados" são estados diferentes, e "erro" e
//     "coleta incompleta" também;
//   - sem cron ativo, a tela diz "atualização manual" e nunca sugere que há
//     sincronização automática;
//   - o espelho é PARCIAL por construção: a cobertura (equipe, canais,
//     situação, período) é mostrada sempre, e nada aqui se apresenta como
//     "o total da Mensageria".
// ===========================================================================
import { useCallback, useState } from "react";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { normalizarEmail } from "../utils/ulbraRecebimento";
import { ND, descreverEstado, fmtHora, fmtMin, fmtNum } from "../utils/ulbraPainel";

// Releitura de reserva do Postgres (não da ULBRA). O botão "reler o espelho"
// relê na hora; isto só cobre a aba deixada aberta.
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

  // Sem e-mail na sessão não há quem consultar: a recusa é derivada do render,
  // não de um setState em efeito (regra react-hooks/set-state-in-effect).
  if (!email || situacao === "negado") {
    return <div className="p-6 text-sm">Esta tela é restrita à gestão.</div>;
  }
  if (situacao === "indisponivel") {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-lg font-semibold">Painel Gestão da Mensageria</h1>
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
        <h1 className="text-lg font-semibold">Painel Gestão da Mensageria</h1>
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

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Painel Gestão da Mensageria</h1>
        <div className="flex items-center gap-3 text-xs">
          <span className={`px-2 py-0.5 rounded ${manual ? "bg-slate-200 text-slate-800" : "bg-emerald-100 text-emerald-800"}`}>
            {manual ? "atualização manual — sem sincronização automática ativa" : "sincronização automática ativa"}
          </span>
          <button type="button" onClick={() => atualizarAgora()} className="px-2 py-1 rounded border bg-white hover:bg-gray-50">
            reler o espelho
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        Lê só o banco do ReATIVA. Reler aqui não faz chamada à Mensageria.
      </p>

      {/* 1 e 5 — CONFIABILIDADE, ANTES DOS NÚMEROS */}
      <section className={`mt-4 rounded border p-3 text-sm ${TOM[est.tom]}`} data-testid="bloco-estado" data-estado={dados.estado}>
        <div className="font-semibold">{est.titulo}</div>
        {est.texto ? <div className="mt-1 text-xs">{est.texto}</div> : null}
        <dl className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Dt k="último ciclo" v={fmtHora(sync.ultima_execucao)} />
          <Dt k="atraso" v={fmtMin(sync.atraso_min)} />
          <Dt k="resultado" v={sync.ultimo_ciclo ? `${sync.ultimo_ciclo}${sync.ultimo_erro ? ` · ${sync.ultimo_erro}` : ""}` : ND} />
          <Dt k="chamadas no dia" v={fmtNum(sync.chamadas_dia)} />
          <Dt k="backlog (fila de detalhes)" v={fmtNum(sync.detalhe_fila_tamanho)} />
          <Dt k="pendências abertas" v={fmtNum(sync.detalhes_pendencias_abertas)} />
          <Dt k="cursor" v={sync.cursor_mensagem ? fmtHora(sync.cursor_mensagem) : "não avançou (ciclo incompleto ou sem ciclo)"} />
          <Dt k="saldo da pessoa do token" v={sync.saldo_api_restam != null ? `${sync.saldo_api_restam} de 500 — fotografia de ${fmtHora(sync.saldo_api_em)}, não saldo final` : ND} />
        </dl>
        {sync.alerta_gestao ? <div className="mt-2 text-xs font-semibold">{sync.alerta_gestao}</div> : null}
      </section>

      {/* 2 — INDICADORES */}
      <section className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <Tile n={fmtNum(atendimentos.sem_responsavel)} r="atendimentos sem responsável" destaque={atendimentos.sem_responsavel > 0} />
        <Tile n={fmtNum(conversas.resposta_aguardando)} r="conversas com resposta do aluno aguardando" />
        <Tile n={fmtNum(conversas.nao_lidas_para_mim)} r="não lidas por você (marcador é por pessoa)" />
        <Tile n={fmtNum(atendimentos.coletados)} r="atendimentos coletados (espelho)" />
        <Tile n={fmtNum(atendimentos.em_conferencia)} r="em conferência da gestão (identidade não confirmada)" destaque={atendimentos.em_conferencia > 0} />
        <Tile n={fmtNum(atendimentos.sem_operador)} r="sem operador disponível na leitura" />
        <Tile n={fmtNum(conversas.identidade_confirmada)} r="conversas com identidade confirmada (CPF)" />
        <Tile n={fmtNum(conversas.total)} r="conversas no espelho" />
      </section>

      <section className="mt-4 grid md:grid-cols-2 gap-4 text-xs">
        {/* 3 — ESPERA, com a base declarada */}
        <div className="rounded border bg-white p-3">
          <div className="font-semibold text-gray-700">Tempo de espera — atendimentos sem responsável</div>
          <div className="text-gray-500 mt-0.5">
            Começa em <strong>{espera.base || ND}</strong>. Não é a hora da coleta.
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <Dt k="na conta" v={fmtNum(espera.n)} />
            <Dt k="sem data de entrada (fora da conta)" v={fmtNum(espera.sem_data)} />
            <Dt k="maior espera" v={fmtMin(espera.max_min)} />
            <Dt k="mediana" v={fmtMin(espera.mediana_min)} />
            <Dt k="acima de 30 min" v={fmtNum(espera.acima_30_min)} />
            <Dt k="resposta de aluno mais antiga aguardando" v={conversas.resposta_mais_antiga_em ? `${fmtHora(conversas.resposta_mais_antiga_em)} (${fmtMin(conversas.espera_resposta_max_min)})` : ND} />
          </dl>
        </div>

        {/* 2 — canal e situação; distribuição comprovada */}
        <div className="rounded border bg-white p-3">
          <div className="font-semibold text-gray-700">Canal e situação</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <Dt k="conversas por canal" v={objeto(conversas.por_canal)} />
            <Dt k="atendimentos por canal" v={atendimentos.por_canal == null ? `${ND} (o espelho de atendimentos não guarda canal)` : objeto(atendimentos.por_canal)} />
            <Dt k="conversas por situação" v={objeto(conversas.por_situacao)} />
            <Dt k="atendimentos por situação" v={objeto(atendimentos.por_situacao)} />
          </dl>
          <div className="font-semibold text-gray-700 mt-3">Distribuição por responsável (posse comprovada)</div>
          {atendimentos.por_responsavel && Object.keys(atendimentos.por_responsavel).length > 0 ? (
            <table className="w-full mt-1 border-t">
              <tbody>
                {Object.entries(atendimentos.por_responsavel).map(([k, v]) => (
                  <tr key={k} className="border-b"><td className="py-1 pr-2">{k}</td><td className="py-1 text-right tabular-nums">{v}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-gray-500 mt-1">nenhum atendimento assumido — zero de verdade, não ausência de dado</div>
          )}
          <div className="text-gray-500 mt-2">
            destino <em>sugerido</em> (não é posse): {objeto(atendimentos.por_destino_sugerido)}
          </div>
          <div className="text-gray-500 mt-1">
            divergência carteira ReATIVA × responsável ULBRA: <strong>{ND}</strong> — depende do mapeamento de operadores; não se calcula por nome.
          </div>
        </div>
      </section>

      {/* 4 — COBERTURA */}
      <section className="mt-4 rounded border bg-white p-3 text-xs text-gray-700" data-testid="cobertura">
        <div className="font-semibold">Cobertura — o que foi coletado, não "o total da Mensageria"</div>
        <dl className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
          <Dt k="equipe" v={cobertura.equipe || ND} />
          <Dt k="canais coletados" v={lista(cobertura.canais_coletados)} />
          <Dt k="canais ativos na coleta" v="WhatsApp (e-mail: não ativo)" />
          <Dt k="situações coletadas" v={lista(cobertura.situacoes_coletadas)} />
          <Dt k="período das conversas" v={periodo(cobertura.periodo?.conversas_de, cobertura.periodo?.conversas_ate)} />
          <Dt k="período dos atendimentos" v={periodo(cobertura.periodo?.atendimentos_de, cobertura.periodo?.atendimentos_ate)} />
          <Dt k="primeira coleta" v={fmtHora(cobertura.periodo?.primeira_coleta)} />
          <Dt k="última coleta" v={fmtHora(cobertura.periodo?.ultima_coleta)} />
          <Dt k="alcance do último ciclo (páginas)" v={cobertura.alcance_paginas == null ? ND : String(cobertura.alcance_paginas)} />
        </dl>
        <div className="mt-2 text-gray-500">
          Mensagem ≠ conversa ≠ atendimento ≠ aluno único. Uma resposta em conversa existente não é lead novo.
        </div>
      </section>
    </div>
  );
}

function Dt({ k, v }) {
  return (
    <>
      <dt className="text-gray-500">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </>
  );
}
function Tile({ n, r, destaque = false }) {
  return (
    <div className={`border rounded p-2 bg-white ${destaque ? "border-amber-400 bg-amber-50" : ""}`}>
      <div className="text-xl font-semibold tabular-nums">{n}</div>
      <div className="text-[11px] text-gray-600 leading-tight">{r}</div>
    </div>
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
function periodo(de, ate) {
  if (!de && !ate) return ND;
  return `${fmtHora(de)} → ${fmtHora(ate)}`;
}
