import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { buscarTudo } from "../utils/paginado";
import { podeVerTudo } from "../utils/operadores";
import { TIPOS_ACIONAMENTO_INDIVIDUAL } from "../utils/carteiraAcionada";
import { AvatarFoto } from "../components/AvatarFoto";
import { Carregando } from "../ui/estados";
import {
  agruparPonto,
  chaveDia,
  corteDoPeriodo,
  cruzarPresencaProducao,
  entradasPorDia,
  pendenciasPorOperador,
  serieAcionamentos,
  ultimosDias,
} from "../utils/produtividade";

/*
  PRODUTIVIDADE OPERACIONAL (gestão)
  ----------------------------------
  Painel de leitura. Não escreve nada, não tem botão de ação e não consulta
  nenhuma função nova: lê três tabelas que já existem e cruza o que já existia
  separado.

  QUEM ENTRA. `podeVerTudo(email)` -- chamado só com o e-mail de propósito,
  porque assim ele devolve exatamente os três logins de gestão
  (Amanda, Fernanda, Amanda ADM), que são os MESMOS de `usuario_e_gestao()` no
  banco. É esse o portão real: a RLS de `ponto_operadores` libera a batida dos
  outros só para `usuario_e_gestao()`, e quem não estiver nela veria apenas a
  própria. Não há permissão nova aqui, nem perfil novo.

  O QUE CADA BLOCO LÊ, E POR QUE NÃO DUPLICA TELA EXISTENTE.

  1) Presença × produção -- `ponto_operadores` + `aluno_movimentacoes`.
     Os dois lados já existiam, nunca no mesmo lugar: a batida de ponto estava
     numa tela que ficou no repositório SEM rota que a renderizasse
     (`PainelOperadores.jsx`, absorvida aqui), e os acionamentos estão na
     Efetividade. O cruzamento é o único indicador que não existe em tela
     nenhuma.

  2) Série diária de acionamentos -- `aluno_movimentacoes` filtrada por
     `TIPOS_ACIONAMENTO_INDIVIDUAL`, a lista canônica da gestão (29/09/2026).
     A Efetividade já mostra o TOTAL do período por operador; o que falta lá é
     a quebra por dia. É só isso que este bloco acrescenta.

  3) Pendências por operador -- `alunos`, com as regras de `public.painel_geral`
     copiadas uma a uma (ver `pendenciasPorOperador`). O Painel Geral já mostra
     esses mesmos números somados para a operação inteira; aqui eles mudam de
     grão, não de definição.

  4) Retornos -- `alunos.data_retorno`. Agendado e vencido são fato na coluna.
     CUMPRIDO não entra: `retorno_confirmado_em` estava preenchido em 0 linhas
     em 22/10/2026. Quem vai passar a alimentá-lo é a frente do Meu Dia.

  5) Evolução -- série de eventos. Não existe snapshot diário de carteira por
     operador, então não há saldo no passado para mostrar; o que há é a data
     que cada evento carrega.
*/

const PERIODOS = [
  { dias: 7, label: "7 dias" },
  { dias: 15, label: "15 dias" },
  { dias: 30, label: "30 dias" },
];

const num = (v) => Number(v || 0).toLocaleString("pt-BR");

function hora(valor) {
  if (!valor) return "—";
  return new Date(valor).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function duracao(minutos) {
  if (minutos == null) return "—";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (!h) return `${m}min`;
  return m ? `${h}h ${m}min` : `${h}h`;
}

// Pausas do dia numa célula só. As três pausas continuam separadas na
// agregação (e descontadas da jornada), mas em coluna própria cada uma ficaria
// vazia por construção: o registro de pausa praticamente não é usado.
function pausasDoDia(pausas) {
  const registradas = (pausas || []).filter((p) => p.inicio);
  if (!registradas.length) return "—";
  return registradas
    .map((p) => `${p.label} ${p.duracao == null ? "em curso" : duracao(p.duracao)}`)
    .join(" · ");
}

function diaBR(chave) {
  const partes = String(chave || "").split("-");
  if (partes.length !== 3) return "—";
  return `${partes[2]}/${partes[1]}`;
}

export default function ProdutividadeOperacional() {
  const [autorizado, setAutorizado] = useState(null); // null = ainda conferindo
  const [periodo, setPeriodo] = useState(7);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAutorizado(podeVerTudo(data?.user?.email || null));
    });
  }, []);

  useEffect(() => {
    if (!autorizado) return;
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autorizado, periodo]);

  async function carregar() {
    setCarregando(true);
    setErro("");

    try {
      const agora = new Date();
      const dias = ultimosDias(periodo, agora);
      const corte = corteDoPeriodo(periodo, agora).toISOString();

      const [movs, alunos, eventosPonto, usuarios] = await Promise.all([
        // Só os tipos canônicos: o filtro vai no banco porque ele derruba o
        // volume de 50.353 linhas de 30 dias para 14.772 (medido 22/10/2026).
        buscarTudo((de, ate) =>
          supabase
            .from("aluno_movimentacoes")
            .select("registrado_por_email,registrado_por_nome,registrado_em")
            .in("tipo", TIPOS_ACIONAMENTO_INDIVIDUAL)
            .gte("registrado_em", corte)
            .order("registrado_em", { ascending: true })
            .order("id", { ascending: true })
            .range(de, ate),
        ),
        // Só quem tem dono: pendência sem operador não tem a quem atribuir, e
        // isso corta a leitura de 18.435 alunos para 7.623.
        buscarTudo((de, ate) =>
          supabase
            .from("alunos")
            .select(
              "id,responsavel_atual_email,responsavel_atual_nome,responsavel_atual_em," +
                "data_ultimo_acionamento,data_retorno,status_atual,status_jornada,status_acionamento",
            )
            .not("responsavel_atual_email", "is", null)
            .order("id", { ascending: true })
            .range(de, ate),
        ),
        buscarTudo((de, ate) =>
          supabase
            .from("ponto_operadores")
            .select("email,nome,tipo,criado_em")
            .gte("criado_em", corte)
            .order("criado_em", { ascending: true })
            .order("id", { ascending: true })
            .range(de, ate),
        ),
        supabase.from("usuarios").select("id,email,apelido"),
      ]);

      const perfis = {};
      for (const u of usuarios?.data || []) {
        perfis[String(u.email || "").toLowerCase().trim()] = u;
      }

      const serie = serieAcionamentos(movs, dias);

      setDados({
        dias,
        serie,
        cruzamento: cruzarPresencaProducao(agruparPonto(eventosPonto), serie),
        pendencias: pendenciasPorOperador(alunos, agora),
        entradas: entradasPorDia(alunos, dias),
        perfis,
        hoje: chaveDia(agora),
        atualizadoEm: agora,
      });
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setCarregando(false);
    }
  }

  if (autorizado === null) {
    return (
      <div style={S.pagina}>
        <Carregando texto="Conferindo acesso…" />
      </div>
    );
  }

  if (!autorizado) {
    return (
      <div style={S.pagina}>
        <h1 style={S.titulo}>Produtividade Operacional</h1>
        <p style={S.aviso}>Este painel é restrito à gestão.</p>
      </div>
    );
  }

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Produtividade Operacional</h1>
          <p style={S.subtitulo}>
            Presença, acionamentos, pendências e entradas na carteira — por operador e por dia.
          </p>
        </div>
        <div style={S.filtros}>
          {PERIODOS.map((p) => (
            <button
              key={p.dias}
              type="button"
              onClick={() => setPeriodo(p.dias)}
              style={periodo === p.dias ? S.filtroAtivo : S.filtro}
            >
              {p.label}
            </button>
          ))}
          <button type="button" style={S.botao} onClick={carregar} disabled={carregando}>
            {carregando ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </div>

      {erro && <p style={S.erro}>Não foi possível carregar: {erro}</p>}

      {!dados ? (
        <Carregando texto="Lendo ponto, movimentações e carteira…" />
      ) : (
        <>
          <Resumo dados={dados} periodo={periodo} />
          <BlocoPresenca dados={dados} />
          <BlocoSerie dados={dados} />
          <BlocoPendencias dados={dados} />
          <BlocoRetornos dados={dados} />
          <BlocoEvolucao dados={dados} />

          <p style={S.rodape}>
            Leitura de {dados.atualizadoEm.toLocaleString("pt-BR")}. Nenhum dado é gravado por esta
            tela.
          </p>
        </>
      )}
    </div>
  );
}

function Resumo({ dados, periodo }) {
  const { serie, pendencias } = dados;

  return (
    <div style={S.kpiGrid}>
      <Kpi cor="var(--rv-azul)" rot={`Acionamentos em ${periodo} dias`} val={num(serie.total)} />
      <Kpi cor="var(--rv-roxo)" rot="Operadores com produção" val={num(serie.operadores.length)} />
      <Kpi cor="var(--rv-texto-forte)" rot="Carteira com dono" val={num(pendencias.totais.carteira)} />
      <Kpi cor="var(--rv-ambar)" rot="Sem contato +10 dias" val={num(pendencias.totais.semContato10)} />
      <Kpi cor="#db2777" rot="Retornos vencidos" val={num(pendencias.totais.retornosVencidos)} />
      <Kpi cor="var(--rv-verde-ok)" rot="Retornos de hoje" val={num(pendencias.totais.retornosHoje)} />
    </div>
  );
}

function BlocoPresenca({ dados }) {
  const { cruzamento, perfis } = dados;

  return (
    <Secao
      titulo="1 · Presença × produção"
      detalhe="Jornada líquida (login ao logout, menos as pausas fechadas) ao lado dos acionamentos do mesmo operador no mesmo dia. Dia sem as duas pontas de ponto não vira hora, e por isso também não vira acionamento por hora — nos últimos 30 dias isso valeu para 229 dos 239 dias-operador com ponto (95,8%). A coluna Pausas tende a ficar vazia: o registro de pausa quase não é usado (3 almoços na história da tabela, o último em 02/07/2026, e nenhum intervalo). Vazio aqui é falta de registro, não falta de pausa."
    >
      {cruzamento.length === 0 ? (
        <p style={S.vazio}>Nenhuma batida de ponto nem acionamento no período.</p>
      ) : (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Dia</th>
                <th style={S.th}>Operador</th>
                <th style={S.th}>Login</th>
                <th style={S.th}>Logout</th>
                <th style={S.th}>Pausas</th>
                <th style={S.thNum}>Jornada</th>
                <th style={S.thNum}>Acionamentos</th>
                <th style={S.thNum}>Por hora</th>
              </tr>
            </thead>
            <tbody>
              {cruzamento.map((linha) => (
                <tr key={`${linha.email}|${linha.dia}`} style={S.tr}>
                  <td style={S.td}>{diaBR(linha.dia)}</td>
                  <td style={S.td}>
                    <span style={S.operador}>
                      <AvatarFoto
                        usuarioId={perfis[linha.email]?.id}
                        nome={perfis[linha.email]?.apelido || linha.nome}
                        tamanho={22}
                      />
                      {perfis[linha.email]?.apelido || linha.nome}
                    </span>
                  </td>
                  {linha.semPonto ? (
                    <td style={{ ...S.td, color: "var(--rv-texto-fraco)" }} colSpan={3}>
                      sem batida de ponto neste dia
                    </td>
                  ) : (
                    <>
                      <td style={S.td}>{hora(linha.login)}</td>
                      <td style={S.td}>{hora(linha.logout)}</td>
                      <td style={S.td}>{pausasDoDia(linha.pausas)}</td>
                    </>
                  )}
                  <td style={S.tdNum}>{duracao(linha.minutosTrabalhados)}</td>
                  <td style={S.tdForte}>{num(linha.acionamentos)}</td>
                  <td style={S.tdNum}>
                    {/* decimal com vírgula sem depender do ICU da máquina */}
                    {linha.porHora == null ? "—" : String(linha.porHora).replace(".", ",")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  );
}

function BlocoSerie({ dados }) {
  const { serie, perfis, hoje } = dados;

  return (
    <Secao
      titulo="2 · Acionamentos por operador e por dia"
      detalhe="Só os tipos da lista canônica da gestão (carteiraAcionada.js): tabulação de atendimento, em atendimento, link enviado, comprovante, retorno de termo, baixa e quitação manual. Ação massiva e movimentação de posse ficam fora, como lá. O total do período por operador também está na Efetividade; o que existe só aqui é a quebra por dia."
    >
      {serie.operadores.length === 0 ? (
        <p style={S.vazio}>Nenhum acionamento no período.</p>
      ) : (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                {serie.dias.map((dia) => (
                  <th key={dia} style={dia === hoje ? S.thHoje : S.thNum}>{diaBR(dia)}</th>
                ))}
                <th style={S.thNum}>Total</th>
              </tr>
            </thead>
            <tbody>
              {serie.operadores.map((op) => (
                <tr key={op.email} style={S.tr}>
                  <td style={S.td}>
                    <span style={S.operador}>
                      <AvatarFoto
                        usuarioId={perfis[op.email]?.id}
                        nome={perfis[op.email]?.apelido || op.nome}
                        tamanho={22}
                      />
                      {perfis[op.email]?.apelido || op.nome}
                    </span>
                  </td>
                  {serie.dias.map((dia) => (
                    <td
                      key={dia}
                      style={op.porDia[dia] ? S.tdNum : { ...S.tdNum, color: "var(--rv-texto-fraco)" }}
                    >
                      {op.porDia[dia] ? num(op.porDia[dia]) : "—"}
                    </td>
                  ))}
                  <td style={S.tdForte}>{num(op.total)}</td>
                </tr>
              ))}
              <tr style={S.trTotal}>
                <td style={S.tdForte}>Total do dia</td>
                {serie.dias.map((dia) => (
                  <td key={dia} style={S.tdForte}>{num(serie.totalPorDia[dia])}</td>
                ))}
                <td style={S.tdForte}>{num(serie.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  );
}

function BlocoPendencias({ dados }) {
  const { pendencias, perfis } = dados;

  return (
    <Secao
      titulo="3 · Pendências por operador"
      detalhe="As mesmas regras do Painel Geral (public.painel_geral), que já mostra estes números somados para a operação inteira: sem contato há mais de 10 dias, em negociação 24h e retorno agendado para hoje. Aluno sem responsável não entra — não há operador a quem atribuir, e ele continua no número global do Painel Geral."
    >
      {pendencias.operadores.length === 0 ? (
        <p style={S.vazio}>Nenhum aluno com responsável atual.</p>
      ) : (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                <th style={S.thNum}>Carteira</th>
                <th style={S.thNum}>Sem contato +10d</th>
                <th style={S.thNum}>% da carteira</th>
                <th style={S.thNum}>Negociação 24h</th>
              </tr>
            </thead>
            <tbody>
              {pendencias.operadores.map((op) => (
                <tr key={op.email} style={S.tr}>
                  <td style={S.td}>
                    <span style={S.operador}>
                      <AvatarFoto
                        usuarioId={perfis[op.email]?.id}
                        nome={perfis[op.email]?.apelido || op.nome}
                        tamanho={22}
                      />
                      {perfis[op.email]?.apelido || op.nome}
                    </span>
                  </td>
                  <td style={S.tdNum}>{num(op.carteira)}</td>
                  <td style={S.tdForte}>{num(op.semContato10)}</td>
                  <td style={S.tdNum}>
                    {op.carteira ? `${Math.round((op.semContato10 / op.carteira) * 100)}%` : "—"}
                  </td>
                  <td style={S.tdNum}>{num(op.negociacao24h)}</td>
                </tr>
              ))}
              <tr style={S.trTotal}>
                <td style={S.tdForte}>Total</td>
                <td style={S.tdForte}>{num(pendencias.totais.carteira)}</td>
                <td style={S.tdForte}>{num(pendencias.totais.semContato10)}</td>
                <td style={S.tdForte}>
                  {pendencias.totais.carteira
                    ? `${Math.round((pendencias.totais.semContato10 / pendencias.totais.carteira) * 100)}%`
                    : "—"}
                </td>
                <td style={S.tdForte}>{num(pendencias.totais.negociacao24h)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  );
}

function BlocoRetornos({ dados }) {
  const { pendencias, perfis } = dados;
  const comRetorno = pendencias.operadores.filter((o) => o.retornosHoje || o.retornosVencidos);

  return (
    <Secao
      titulo="4 · Retornos"
      detalhe="Agendado para hoje e vencido, pela data do retorno combinado. Retorno CUMPRIDO não está aqui de propósito: o campo que marca o retorno como tratado estava preenchido em 0 de 18.435 alunos em 22/10/2026 — ninguém marca. Medir isso depende de a frente do Meu Dia passar a alimentá-lo; até lá, qualquer número de 'cumpridos' seria inventado."
    >
      {comRetorno.length === 0 ? (
        <p style={S.vazio}>Nenhum retorno agendado para hoje nem vencido.</p>
      ) : (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                <th style={S.thNum}>Agendados para hoje</th>
                <th style={S.thNum}>Vencidos</th>
              </tr>
            </thead>
            <tbody>
              {comRetorno.map((op) => (
                <tr key={op.email} style={S.tr}>
                  <td style={S.td}>
                    <span style={S.operador}>
                      <AvatarFoto
                        usuarioId={perfis[op.email]?.id}
                        nome={perfis[op.email]?.apelido || op.nome}
                        tamanho={22}
                      />
                      {perfis[op.email]?.apelido || op.nome}
                    </span>
                  </td>
                  <td style={S.tdNum}>{num(op.retornosHoje)}</td>
                  <td style={op.retornosVencidos ? S.tdAlerta : S.tdNum}>
                    {num(op.retornosVencidos)}
                  </td>
                </tr>
              ))}
              <tr style={S.trTotal}>
                <td style={S.tdForte}>Total</td>
                <td style={S.tdForte}>{num(pendencias.totais.retornosHoje)}</td>
                <td style={S.tdForte}>{num(pendencias.totais.retornosVencidos)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  );
}

function BlocoEvolucao({ dados }) {
  const { serie, entradas } = dados;
  const teto = Math.max(1, ...serie.dias.map((d) => serie.totalPorDia[d] || 0));

  return (
    <Secao
      titulo="5 · Evolução no período"
      detalhe="Série de eventos, não de saldo: cada linha vem de uma coluna que carrega a própria data. 'Entradas na carteira' é a data em que o aluno passou ao responsável ATUAL (alunos.responsavel_atual_em) — quem ele teve e perdeu não aparece, porque a coluna guarda um valor só. Saldo de carteira no passado exigiria snapshot diário, que não existe no banco."
    >
      <div style={S.rolagem}>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Dia</th>
              <th style={S.thNum}>Acionamentos</th>
              <th style={S.th}>&nbsp;</th>
              <th style={S.thNum}>Entradas na carteira</th>
            </tr>
          </thead>
          <tbody>
            {serie.dias.map((dia) => (
              <tr key={dia} style={S.tr}>
                <td style={S.td}>{diaBR(dia)}</td>
                <td style={S.tdForte}>{num(serie.totalPorDia[dia])}</td>
                <td style={S.td}>
                  <span style={S.barraFundo}>
                    <span
                      style={{
                        ...S.barra,
                        width: `${Math.round(((serie.totalPorDia[dia] || 0) / teto) * 100)}%`,
                      }}
                    />
                  </span>
                </td>
                <td style={S.tdNum}>{num(entradas.totalPorDia[dia])}</td>
              </tr>
            ))}
            <tr style={S.trTotal}>
              <td style={S.tdForte}>Total</td>
              <td style={S.tdForte}>{num(serie.total)}</td>
              <td style={S.td}>&nbsp;</td>
              <td style={S.tdForte}>{num(entradas.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Secao>
  );
}

function Secao({ titulo, detalhe, children }) {
  return (
    <section style={S.secao}>
      <h2 style={S.tituloSecao}>{titulo}</h2>
      <p style={S.detalhe}>{detalhe}</p>
      {children}
    </section>
  );
}

function Kpi({ rot, val, cor }) {
  return (
    <div style={{ ...S.kpiCard, borderTop: `3px solid ${cor}` }}>
      <p style={S.kpiRot}>{rot}</p>
      <p style={S.kpiVal}>{val}</p>
    </div>
  );
}

const S = {
  pagina: { padding: 24, maxWidth: 1320, margin: "0 auto" },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 16,
    flexWrap: "wrap",
    marginBottom: 18,
  },
  titulo: { fontSize: 24, fontWeight: 800, margin: 0 },
  subtitulo: { fontSize: 13, color: "var(--rv-texto-fraco)", margin: "4px 0 0" },
  filtros: { display: "flex", gap: 8, flexWrap: "wrap" },
  filtro: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(148,163,184,0.35)",
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
  },
  filtroAtivo: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(59,130,246,0.7)",
    background: "rgba(59,130,246,0.15)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
  },
  botao: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(148,163,184,0.35)",
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  aviso: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    background: "rgba(251,191,36,0.12)",
    fontSize: 14,
  },
  erro: { color: "#dc2626", fontSize: 13, marginBottom: 12 },
  vazio: { fontSize: 13, color: "var(--rv-texto-fraco)", margin: 0 },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
    gap: 12,
    marginBottom: 22,
  },
  kpiCard: {
    borderRadius: 10,
    padding: "12px 14px",
    background: "rgba(148,163,184,0.08)",
    border: "1px solid rgba(148,163,184,0.18)",
  },
  kpiRot: { fontSize: 12, color: "var(--rv-texto-fraco)", margin: 0 },
  kpiVal: { fontSize: 22, fontWeight: 800, margin: "4px 0 0" },
  secao: { marginBottom: 28 },
  tituloSecao: { fontSize: 17, fontWeight: 800, margin: "0 0 4px" },
  detalhe: {
    fontSize: 12,
    color: "var(--rv-texto-fraco)",
    margin: "0 0 10px",
    maxWidth: 940,
    lineHeight: 1.5,
  },
  rolagem: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(148,163,184,0.3)",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  thNum: {
    textAlign: "right",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(148,163,184,0.3)",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  thHoje: {
    textAlign: "right",
    padding: "8px 10px",
    borderBottom: "2px solid rgba(59,130,246,0.7)",
    fontSize: 12,
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid rgba(148,163,184,0.12)" },
  trTotal: { borderTop: "1px solid rgba(148,163,184,0.35)" },
  td: { padding: "8px 10px", whiteSpace: "nowrap" },
  tdNum: { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" },
  tdAlerta: { padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#db2777" },
  operador: { display: "inline-flex", alignItems: "center", gap: 8 },
  barraFundo: {
    display: "block",
    width: 220,
    height: 8,
    borderRadius: 4,
    background: "rgba(148,163,184,0.2)",
  },
  barra: { display: "block", height: 8, borderRadius: 4, background: "var(--rv-azul)" },
  rodape: { fontSize: 12, color: "var(--rv-texto-fraco)", marginTop: 8 },
};
