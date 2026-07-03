import { useEffect, useRef } from "react";
import { supabase } from "../services/supabase";
import { registrarLogout } from "../utils/ponto";

// Desloga o usuário automaticamente depois de 30 minutos sem nenhuma
// atividade na tela (mouse, teclado, toque ou rolagem). Ao sair — aqui ou
// pelo botão Sair — o operador também é removido na hora da fila do
// receptivo, pra não ficar segurando a vez sem estar realmente trabalhando.
const LIMITE_INATIVIDADE_MS = 30 * 60 * 1000;

export default function AutoLogout({ usuario }) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!usuario) return;

    const email = usuario?.perfil?.email || usuario?.auth?.email || null;
    const nome = usuario?.perfil?.nome || null;

    async function sairPorInatividade() {
      try {
        await registrarLogout(email, nome);
      } catch (e) {
        console.warn("Erro ao registrar logout por inatividade:", e);
      }
      try {
        if (email) {
          await supabase.rpc("fila_receptivo_sair", { p_email: email });
        }
      } catch (e) {
        console.warn("Erro ao sair da fila no logout por inatividade:", e);
      }
      await supabase.auth.signOut();
      window.location.href = "/";
    }

    function reiniciarTimer() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(sairPorInatividade, LIMITE_INATIVIDADE_MS);
    }

    const eventos = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    eventos.forEach((evento) =>
      window.addEventListener(evento, reiniciarTimer, { passive: true })
    );

    reiniciarTimer();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      eventos.forEach((evento) => window.removeEventListener(evento, reiniciarTimer));
    };
  }, [usuario]);

  return null;
}
