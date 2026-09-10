import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "../pages/Aluno";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import { podeAlterarOperadorProjecao } from "../utils/operadores";

// Acordo ATIVO com o responsavel em branco -- o campo
// acordos.operador_responsavel_email.
//
// ATENCAO ao mexer aqui: ate 10/09/2026 esta fila filtrava pelo dono do CASO
// (casos.operador_email), e nao pelo responsavel do ACORDO. Como depois do giro
// quase todo caso tem dono, ela mostrava 12 de ~930 acordos. Um acordo de
// R$ 236.929,17 nunca apareceu porque a ficha da aluna tinha dona. Sao campos
// diferentes: dono da ficha nao e responsavel pelo acordo.
//
// A gestao confere caso a caso no Prime para descobrir quem negociou, e so
// entao vincula. Por isso o seletor e POR LINHA e nao ha "vincular todos":
// mandar 880 acordos para alguem em lote seria inventar dono, que e justamente
// o problema que esta fila existe para consertar.
const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (d) => (d ? new Date(d).toLocaleDateString("pt-BR") : "—");

// ATENCAO: a RPC devolve 880 linhas hoje. O PostgREST corta em 1.000 por
// padrao e nao avisa -- ja nos mordeu duas vezes em 10/09/2026. Se este numero
// encostar em 1.000, paginar no servidor em vez de no navegador.
const POR_PAGINA = 50;

export default function AcordosSemResponsavel({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [pessoas, setPessoas] = useState([]);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [fichaId, setFichaId] = useState(null);
  const [escolha, setEscolha] = useState({});
  const [vinculando, setVinculando] = useState({});
  const [pagina, setPagina] = useState(0);
  const [emailUsuario, setEmailUsuario] = useState("");
  const [busca, setBusca] = useState("");
  const emVooRef = useRef(false);

  const podeVincular = podeAlterarOperadorProjecao(emailUsuario);

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("fila_acordos_sem_responsavel");
    emVooRef.current = false;
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar os acordos sem responsável.");
      return;
    }
    setLista(data || []);
  }, []);

  useEffect(() => {
    // Carga unica ao montar -- a aba so monta quando esta ativa. A regra
    // set-state-in-effect existe para evitar renderizacao em cascata; aqui o
    // setState acontece depois do await da RPC, e buscar os dados ao abrir e
    // justamente o que a aba precisa fazer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // O portao do servidor e a RPC; este aqui e so para nao mostrar um botao
    // que a pessoa nao pode usar. O FinanceiroHub nao carrega o usuario, entao
    // a tela le a propria sessao em vez de receber prop por tres camadas.
    let vivo = true;
    supabase.auth.getUser().then(({ data }) => {
      if (vivo) setEmailUsuario(data?.user?.email || "");
    });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    let vivo = true;
    supabase
      .from("usuarios")
      .select("email, nome")
      .eq("ativo", true)
      .order("nome")
      .then(({ data }) => {
        if (vivo && Array.isArray(data)) setPessoas(data);
      });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  async function vincular(linha) {
    const email = escolha[linha.acordo_id];
    if (!email) return;
    const pessoa = pessoas.find((p) => p.email === email);
    const ok = window.confirm(
      `Vincular este acordo a ${pessoa?.nome || email}?\n\n` +
        `${linha.aluno || linha.cpf} — ${moeda(linha.saldo_aberto)} em aberto\n\n` +
        `Só o responsável do acordo muda. A carteira e o dono da ficha ficam como estão.`
    );
    if (!ok) return;

    setVinculando((s) => ({ ...s, [linha.acordo_id]: true }));
    setAviso("");
    const { data, error } = await supabase.rpc("vincular_responsavel_acordo", {
      p_acordo_ids: [linha.acordo_id],
      p_email: email,
    });
    setVinculando((s) => ({ ...s, [linha.acordo_id]: false }));
    if (error) {
      setAviso("Não foi possível vincular: " + (error.message || ""));
      return;
    }
    if (!data?.vinculados) {
      setAviso("Este acordo já tinha responsável — a lista foi atualizada.");
      carregar();
      return;
    }
    setAviso(`${linha.aluno || linha.cpf}: acordo vinculado a ${data.operador_nome}.`);
    // Sai da lista sem recarregar as 880 linhas de novo.
    setLista((l) => l.filter((x) => x.acordo_id !== linha.acordo_id));
  }

  const filtrada = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter(
      (l) =>
        (l.aluno || "").toLowerCase().includes(q) ||
        (l.cpf || "").includes(q.replace(/\D/g, ""))
    );
  }, [lista, busca]);

  const total = filtrada.reduce((t, l) => t + Number(l.saldo_aberto || 0), 0);
  const paginas = Math.max(1, Math.ceil(filtrada.length / POR_PAGINA));
  const p = Math.min(pagina, paginas - 1);
  const visiveis = filtrada.slice(p * POR_PAGINA, (p + 1) * POR_PAGINA);
  const semCaso = lista.filter((l) => l.situacao !== "COM_CASO").length;

  if (carregando && !lista.length) {
    return <Carregando texto="Carregando acordos sem responsável…" />;
  }

  return (
    <div>
      <div style={A.topo}>
        <div>
          <h2 style={A.titulo}>Acordos sem responsável</h2>
          <p style={A.sub}>
            Acordo ativo com o responsável em branco. Confira no Prime quem negociou
            e vincule caso a caso — só o acordo muda de dono, a carteira não é tocada.
          </p>
        </div>
        <div style={A.contadores}>
          <span style={A.contadorAcordos}>{filtrada.length} acordos</span>
          <span style={A.contadorValor}>{moeda(total)} em aberto</span>
          {semCaso ? (
            <span style={A.contadorAlunos}>{semCaso} sem caso no CRM</span>
          ) : null}
        </div>
      </div>

      <div style={A.barra}>
        <input
          type="search"
          value={busca}
          placeholder="Buscar por nome ou CPF"
          onChange={(e) => { setBusca(e.target.value); setPagina(0); }}
          style={A.input}
        />
        <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
        {paginas > 1 ? (
          <span style={A.muted}>
            <button
              type="button"
              style={A.btnGhostClaro}
              disabled={p === 0}
              onClick={() => setPagina(p - 1)}
            >
              ‹
            </button>
            {" "}página {p + 1} de {paginas}{" "}
            <button
              type="button"
              style={A.btnGhostClaro}
              disabled={p >= paginas - 1}
              onClick={() => setPagina(p + 1)}
            >
              ›
            </button>
          </span>
        ) : null}
      </div>

      {erro ? <div style={A.erroBox}>{erro}</div> : null}
      {aviso ? <div style={A.erroBox}>{aviso}</div> : null}
      {!podeVincular ? (
        <p style={A.muted}>
          Você pode consultar a lista. Vincular o responsável é da Amanda e da Fernanda.
        </p>
      ) : null}

      {!filtrada.length ? (
        <p style={A.muted}>
          {busca ? "Nenhum acordo com esse nome ou CPF." : "Nenhum acordo sem responsável."}
        </p>
      ) : (
        <div style={A.card}>
          <table style={A.tabela}>
            <thead>
              <tr>
                <th style={A.th}>Aluno</th>
                <th style={A.th}>CPF</th>
                <th style={A.thNum}>Em aberto</th>
                <th style={A.thNum}>Vencidas</th>
                <th style={A.thNum}>Atraso</th>
                <th style={A.th}>Acordo de</th>
                <th style={A.th}>Ficha com</th>
                <th style={A.th}>Vincular a</th>
                <th style={A.th}></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.acordo_id}>
                  <td style={A.td}>
                    {l.aluno || "—"}
                    {/* O aluno existe, o caso nao. Nao impede vincular o acordo,
                        mas explica por que algumas telas nao acham essa pessoa. */}
                    {l.situacao === "SEM_CASO" ? (
                      <span style={{ ...A.chip, ...A.chipPend, marginLeft: 8 }}>sem caso</span>
                    ) : null}
                    {l.situacao === "SEM_FICHA" ? (
                      <span style={{ ...A.chip, ...A.chipRej, marginLeft: 8 }}>sem cadastro</span>
                    ) : null}
                  </td>
                  <td style={A.td}>{l.cpf || "—"}</td>
                  <td style={A.tdNum}>{moeda(l.saldo_aberto)}</td>
                  <td style={A.tdNum}>{l.parcelas_vencidas || 0}</td>
                  <td style={A.tdNum}>{l.dias_atraso ? `${l.dias_atraso} d` : "—"}</td>
                  <td style={A.td}>{dia(l.criado_em)}</td>
                  {/* Informacao, nao filtro: ajuda a decidir a quem vincular,
                      mas nao determina nada. */}
                  <td style={A.td}>
                    {l.dono_caso_nome
                      ? <span style={A.resp}>{l.dono_caso_nome}</span>
                      : <span style={A.respVazio}>—</span>}
                  </td>
                  <td style={A.td}>
                    <select
                      style={A.select || A.input}
                      disabled={!podeVincular}
                      value={escolha[l.acordo_id] || ""}
                      onChange={(e) =>
                        setEscolha((x) => ({ ...x, [l.acordo_id]: e.target.value }))
                      }
                    >
                      <option value="">Escolher…</option>
                      {pessoas.map((pe) => (
                        <option key={pe.email} value={pe.email}>{pe.nome}</option>
                      ))}
                    </select>
                  </td>
                  <td style={A.td}>
                    <div style={A.acoes}>
                      {l.aluno_id ? (
                        <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                          Ficha
                        </button>
                      ) : null}
                      {podeVincular ? (
                        <button
                          type="button"
                          style={
                            vinculando[l.acordo_id] || !escolha[l.acordo_id]
                              ? { ...A.btnConf, ...A.btnBusy }
                              : A.btnConf
                          }
                          disabled={!!vinculando[l.acordo_id] || !escolha[l.acordo_id]}
                          onClick={() => vincular(l)}
                        >
                          Vincular
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fichaId ? (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <strong>Ficha do aluno</strong>
              <button type="button" style={A.btnGhostClaro} onClick={() => setFichaId(null)}>Fechar</button>
            </div>
            <div style={{ overflow: "auto" }}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
