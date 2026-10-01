import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import {
  ALVO_PLAYLIST, MODO_SEMANA, RPC_POR_MODO,
  indexarCurtidas, alternarLocal, estruturaAusente, mensagemErroCurtida,
} from "./curtidas";

// Curtidas de um tipo de alvo, na semana corrente (a janela e calculada no banco,
// em America/Sao_Paulo). Serve playlist agora e os outros alvos depois.
//
// `disponivel` fica falso quando a migration do A2 ainda nao foi aplicada no
// banco: nesse caso a tela some com o bloco de curtidas em vez de quebrar.
// A gravacao da curtida, isolada para ter UMA implementacao: o hook usa, e quem
// recebe a contagem por outra via (o mural de ideias, que precisa ordenar por
// curtidas no banco) usa a mesma coisa.
export async function gravarCurtida({ alvoTipo, alvoId, email, jaCurtida }) {
  if (jaCurtida) {
    return supabase.from("portal_curtidas").delete()
      .eq("alvo_tipo", alvoTipo).eq("alvo_id", alvoId).ilike("usuario_email", email);
  }
  return supabase.from("portal_curtidas")
    .insert({ alvo_tipo: alvoTipo, alvo_id: alvoId, usuario_email: email });
}

export default function useCurtidas(alvoTipo = ALVO_PLAYLIST, modo = MODO_SEMANA) {
  const [mapa, setMapa] = useState(() => new Map());
  const [disponivel, setDisponivel] = useState(true);
  const [ocupado, setOcupado] = useState(null);

  const buscar = useCallback(
    () => supabase.rpc(RPC_POR_MODO[modo], { p_alvo_tipo: alvoTipo }),
    [alvoTipo, modo],
  );

  const aplicar = useCallback(({ data, error }) => {
    if (error) {
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      console.error(`${RPC_POR_MODO[modo]}:`, error);
      return;
    }
    setDisponivel(true);
    setMapa(indexarCurtidas(data));
  }, [modo]);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  const recarregar = useCallback(async () => { aplicar(await buscar()); }, [buscar, aplicar]);

  // Curtir se ainda nao curti; retirar a minha curtida se ja curti.
  // A unicidade real e do banco (indice unico); aqui e so a tela.
  const alternar = useCallback(async (alvoId, email) => {
    if (!email) {
      alert("Sua sessão ainda não foi identificada. Atualize a página e tente novamente.");
      return;
    }
    const jaCurtida = mapa.get(alvoId)?.euCurti === true;

    setOcupado(alvoId);
    setMapa((m) => alternarLocal(m, alvoId)); // resposta imediata na tela

    const { error } = await gravarCurtida({ alvoTipo, alvoId, email, jaCurtida });

    setOcupado(null);

    if (error) {
      console.error(jaCurtida ? "Erro ao retirar curtida:" : "Erro ao curtir:", error);
      if (estruturaAusente(error)) setDisponivel(false);
      else alert(mensagemErroCurtida(error, jaCurtida));
    }
    // Recarrega sempre: confirma o otimismo ou desfaz o que nao valeu.
    await recarregar();
  }, [mapa, alvoTipo, recarregar]);

  return { mapa, disponivel, ocupado, alternar, recarregar };
}
