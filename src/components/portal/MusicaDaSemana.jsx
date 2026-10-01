import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { estruturaAusente, rotuloCurtidas } from "./curtidas";
import { linkDoYoutube } from "./playlist";

export const SEM_VENCEDORA = "A semana ainda não tem uma música mais curtida.";

// Faixa de destaque da Visao Geral: a musica mais curtida da semana corrente.
// A regra (janela em America/Sao_Paulo, desempate, so musica ativa) mora toda na
// RPC portal_musica_da_semana -- aqui e so apresentacao.
export default function MusicaDaSemana({ recarregarEm = 0, S }) {
  const [musica, setMusica] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [disponivel, setDisponivel] = useState(true);

  const buscar = useCallback(() => supabase.rpc("portal_musica_da_semana"), []);

  const aplicar = useCallback(({ data, error }) => {
    setCarregando(false);
    if (error) {
      // Enquanto a migration do A2 nao estiver aplicada, a faixa nao aparece --
      // em vez de derrubar a Home inteira.
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      console.error("portal_musica_da_semana:", error);
      setMusica(null);
      return;
    }
    setDisponivel(true);
    setMusica(Array.isArray(data) ? (data[0] ?? null) : (data ?? null));
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar, recarregarEm]);

  if (!disponivel) return null;

  return (
    <section style={S.semanaFaixa}>
      <div style={S.semanaRotulo}>
        <span style={S.semanaIcone}>🎵</span>
        <span style={S.semanaEyebrow}>MÚSICA MAIS CURTIDA DA SEMANA</span>
      </div>

      {musica ? (
        <a href={linkDoYoutube(musica.youtube_id)} target="_blank" rel="noreferrer" style={S.semanaAlvo}>
          <img src={`https://i.ytimg.com/vi/${musica.youtube_id}/mqdefault.jpg`} alt="" style={S.semanaCapa} />
          <div style={S.semanaTexto}>
            <strong style={S.semanaTitulo}>{musica.titulo}</strong>
            <span style={S.semanaArtista}>{musica.artista}</span>
            <span style={S.semanaQuem}>Escolhida por {musica.adicionado_por}</span>
          </div>
          <div style={S.semanaContagem}>
            <strong style={S.semanaNumero}>❤️ {musica.curtidas}</strong>
            <span style={S.semanaNumeroRotulo}>{rotuloCurtidas(musica.curtidas)}</span>
          </div>
        </a>
      ) : (
        <p style={S.semanaVazio}>
          {carregando ? "Apurando as curtidas da semana..." : SEM_VENCEDORA}
          {!carregando && <span style={S.semanaVazioDica}> Curta uma música da playlist para ela aparecer aqui.</span>}
        </p>
      )}
    </section>
  );
}
