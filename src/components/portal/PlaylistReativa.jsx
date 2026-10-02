import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabase";
import { nomeOperadorPorEmail } from "../../utils/operadores";
import {
  LIMITE_MUSICAS, ERRO_LIMITE, extrairYoutubeId, mesmaPessoa, contarAtivasDe, linkDoYoutube,
} from "./playlist";
import { curtidasDe } from "./curtidas";

const VAZIO = { titulo: "", artista: "", link: "" };
const VISIVEIS = 6;
const CAMPOS = "id,titulo,artista,youtube_id,adicionado_por,adicionado_por_email,ativo,criado_em";

export default function PlaylistReativa({ usuario, curtidas, Card, CabecalhoCard, S }) {
  const [playlist, setPlaylist] = useState([]);
  const [erro, setErro] = useState("");
  const [aberto, setAberto] = useState(false);
  const [editando, setEditando] = useState(null);
  const [form, setForm] = useState(VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [removendo, setRemovendo] = useState(null);
  const [mostrarTodas, setMostrarTodas] = useState(false);

  const email = usuario?.email || "";

  const buscar = useCallback(() => supabase
    .from("portal_playlist")
    .select(CAMPOS)
    .eq("ativo", true)
    .order("criado_em", { ascending: false })
    .limit(60), []);

  const aplicar = useCallback(({ data, error }) => {
    if (error) {
      console.error("portal_playlist:", error);
      setErro("Playlist temporariamente indisponível. A gestão já pode identificar o motivo pelo código do erro.");
      return;
    }
    setErro("");
    setPlaylist(data || []);
  }, []);

  const recarregar = useCallback(async () => { aplicar(await buscar()); }, [buscar, aplicar]);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  const minhas = useMemo(() => contarAtivasDe(playlist, email), [playlist, email]);
  const noLimite = minhas >= LIMITE_MUSICAS;
  const vagas = Math.max(0, LIMITE_MUSICAS - minhas);

  function abrirNova() {
    setEditando(null);
    setForm(VAZIO);
    setAberto((v) => !v);
  }

  function abrirEdicao(item) {
    setEditando(item.id);
    setForm({ titulo: item.titulo || "", artista: item.artista || "", link: linkDoYoutube(item.youtube_id) });
    setAberto(true);
  }

  function fechar() {
    setAberto(false);
    setEditando(null);
    setForm(VAZIO);
  }

  async function enviar(e) {
    e.preventDefault();

    if (!email) {
      alert("Sua sessão ainda não foi identificada. Atualize a página e tente novamente.");
      return;
    }
    const youtubeId = extrairYoutubeId(form.link);
    if (!form.titulo.trim() || !form.artista.trim() || !youtubeId) {
      alert("Informe música, artista e um link válido do YouTube.");
      return;
    }
    // Editar NAO consome vaga; so a inclusao precisa de vaga livre.
    if (!editando && noLimite) {
      alert(`Você já atingiu o limite de ${LIMITE_MUSICAS} músicas.`);
      return;
    }

    setSalvando(true);
    const campos = { titulo: form.titulo.trim(), artista: form.artista.trim(), youtube_id: youtubeId };
    const { error } = editando
      ? await supabase.from("portal_playlist").update(campos).eq("id", editando)
      : await supabase.from("portal_playlist").insert({
          ...campos,
          adicionado_por: usuario?.nome || nomeOperadorPorEmail(email),
          adicionado_por_email: email,
        });
    setSalvando(false);

    if (error) {
      console.error(editando ? "Erro ao editar música:" : "Erro ao adicionar música:", error);
      if (error.code === ERRO_LIMITE) {
        alert(`Você já atingiu o limite de ${LIMITE_MUSICAS} músicas.`);
      } else if (error.code === "42501") {
        alert("Sua conta não tem permissão para esta ação na playlist. Avise a gestão.");
      } else if (error.code === "42P01" || error.code === "PGRST205") {
        alert("A Playlist ReATIVA ainda não está ativada no banco de produção. Avise a gestão.");
      } else {
        alert(`Não foi possível salvar a música. Código: ${error.code || "sem código"}.`);
      }
      return;
    }

    fechar();
    recarregar();
    curtidas?.recarregar?.();
  }

  // Soft delete: a linha continua no banco com ativo = false, e a vaga volta.
  async function remover(item) {
    if (!window.confirm(`Remover "${item.titulo}" da playlist? A vaga volta a ficar livre.`)) return;

    setRemovendo(item.id);
    const { error } = await supabase.from("portal_playlist").update({ ativo: false }).eq("id", item.id);
    setRemovendo(null);

    if (error) {
      console.error("Erro ao remover música:", error);
      alert(`Não foi possível remover a música. Código: ${error.code || "sem código"}.`);
      return;
    }
    recarregar();
    curtidas?.recarregar?.();
  }

  const lista = mostrarTodas ? playlist : playlist.slice(0, VISIVEIS);

  return (
    <Card style={S.playlistCard}>
      <CabecalhoCard
        icone="🎧"
        titulo="Playlist ReATIVA"
        acao={
          <button
            type="button"
            onClick={abrirNova}
            disabled={noLimite && !aberto}
            title={noLimite ? `Você já atingiu o limite de ${LIMITE_MUSICAS} músicas.` : undefined}
            style={{ ...S.botaoMini, ...(noLimite && !aberto ? S.botaoMiniDesligado : null) }}
          >
            {aberto ? "Fechar" : "+ Minha música"}
          </button>
        }
      />

      <div style={S.playlistContador}>
        <strong style={S.playlistContadorForte}>Suas músicas: {minhas} de {LIMITE_MUSICAS}</strong>
        <span style={S.mutedPequeno}>
          {noLimite
            ? `Você já atingiu o limite de ${LIMITE_MUSICAS} músicas. Remova uma para liberar uma vaga.`
            : `Você ainda pode incluir ${vagas} ${vagas === 1 ? "música" : "músicas"}. Remover uma libera a vaga na hora.`}
        </span>
      </div>

      {aberto && (
        <form onSubmit={enviar} style={S.form}>
          <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Música" style={S.input} />
          <input value={form.artista} onChange={(e) => setForm({ ...form, artista: e.target.value })} placeholder="Artista" style={S.input} />
          <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="Link do YouTube" style={S.input} />
          <div style={S.formLinha}>
            <button disabled={salvando} style={S.botaoPrimario}>
              {salvando ? "Salvando..." : editando ? "Salvar alterações" : "Adicionar"}
            </button>
            <button type="button" onClick={fechar} style={S.botaoMini}>Cancelar</button>
          </div>
        </form>
      )}

      <div style={S.listaMusicas}>
        {lista.length ? lista.map((item, idx) => {
          const minha = mesmaPessoa(item.adicionado_por_email, email);
          return (
            <div key={item.id} style={S.musicaLinha}>
              <a href={linkDoYoutube(item.youtube_id)} target="_blank" rel="noreferrer" style={S.musicaAlvo}>
                <img src={`https://i.ytimg.com/vi/${item.youtube_id}/mqdefault.jpg`} alt="" style={S.thumb} />
                <div style={S.musicaTexto}>
                  <span style={S.badge}>{!mostrarTodas && idx === 0 ? "MÚSICA DA VEZ" : "PLAYLIST"}</span>
                  <strong style={S.musicaTitulo}>{item.titulo}</strong>
                  <span style={S.musicaArtista}>{item.artista}</span>
                  <span style={S.adicionadoPor}>Escolhida por {item.adicionado_por}</span>
                </div>
              </a>
              <div style={S.musicaAcoes}>
                {curtidas?.disponivel && (
                  <button
                    type="button"
                    onClick={() => curtidas.alternar(item.id, email)}
                    disabled={curtidas.ocupado === item.id}
                    aria-pressed={curtidasDe(curtidas.mapa, item.id).euCurti}
                    title={curtidasDe(curtidas.mapa, item.id).euCurti ? "Retirar minha curtida" : "Curtir esta música"}
                    style={{ ...S.botaoCurtir, ...(curtidasDe(curtidas.mapa, item.id).euCurti ? S.botaoCurtirAtivo : null) }}
                  >
                    {curtidasDe(curtidas.mapa, item.id).euCurti ? "❤️" : "🤍"} {curtidasDe(curtidas.mapa, item.id).curtidas}
                  </button>
                )}
                {minha && (
                  <>
                    <button type="button" onClick={() => abrirEdicao(item)} style={S.botaoAcaoMusica}>Editar</button>
                    <button type="button" onClick={() => remover(item)} disabled={removendo === item.id} style={S.botaoAcaoMusica}>
                      {removendo === item.id ? "..." : "Remover"}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        }) : <p style={S.muted}>{erro || "A playlist começa com a primeira indicação da equipe."}</p>}
      </div>

      {playlist.length > VISIVEIS && (
        <button type="button" onClick={() => setMostrarTodas((v) => !v)} style={S.playlistVerTodas}>
          {mostrarTodas ? "Mostrar menos" : `Mostrar todas (${playlist.length})`}
        </button>
      )}
    </Card>
  );
}
