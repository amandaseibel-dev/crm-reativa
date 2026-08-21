import { createContext, useContext, useEffect, useRef, useState } from "react";
import { criarControleAbasPorVagas } from "../utils/abaLider";
import { supabase } from "../services/supabase";

// Contexto de aba única. O provider descobre o usuário logado pela sessão do
// Supabase (escopo por session.user.id) e roda a eleição de líder. A árvore
// operacional consome `ehLider` / `souSecundaria` para decidir se monta o CRM.
//
// Importante: apenas LEITURA da sessão de auth (getSession / onAuthStateChange).
// Não altera Supabase, RPCs, RLS nem dados.
const AbaLiderContext = createContext({
  ehLider: true,
  souSecundaria: false,
  degradado: true,
  pronto: false,
  liderPodeTerEncerrado: false,
  assumirLideranca: () => {},
});

export function useAbaLider() {
  return useContext(AbaLiderContext);
}

export function AbaLiderProvider({ children }) {
  const [userId, setUserId] = useState(null);
  const [ehLider, setEhLider] = useState(true);
  const [degradado, setDegradado] = useState(false);
  const [pronto, setPronto] = useState(false);
  const [pareceExpirada, setPareceExpirada] = useState(false);
  const controleRef = useRef(null);

  // Descobre o usuário logado (escopo da eleição). Só o id é usado — nunca
  // nome, CPF, telefone ou e-mail.
  useEffect(() => {
    let vivo = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!vivo) return;
      setUserId(data?.session?.user?.id || null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id || null);
    });
    return () => {
      vivo = false;
      try {
        sub?.subscription?.unsubscribe();
      } catch (e) {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    // Sem usuário: nada a coordenar. Estado neutro (não interfere no login).
    if (!userId) {
      if (controleRef.current) {
        controleRef.current.destruir();
        controleRef.current = null;
      }
      setEhLider(true);
      setDegradado(false);
      setPronto(false);
      setPareceExpirada(false);
      return undefined;
    }

    const controle = criarControleAbasPorVagas(userId, {
      onMudanca: (estado) => {
        setEhLider(estado.ehLider);
        setDegradado(estado.degradado);
        setPareceExpirada(estado.pareceExpirada);
        setPronto(true);
      },
    });
    controleRef.current = controle;
    controle.iniciar();
    // Estado inicial imediato (o onMudanca só dispara em transições).
    const inicial = controle.estado();
    setEhLider(inicial.ehLider);
    setDegradado(inicial.degradado);
    setPareceExpirada(inicial.pareceExpirada);
    setPronto(true);

    return () => {
      controle.destruir();
      controleRef.current = null;
    };
  }, [userId]);

  function assumirLideranca() {
    if (controleRef.current) controleRef.current.assumirForcado();
  }

  // souSecundaria: há usuário, o controle está pronto, e esta aba NÃO é líder.
  const souSecundaria = Boolean(userId) && pronto && !ehLider;
  // A outra aba pode ter sido encerrada abruptamente (registro velho, sem
  // liberação). Nunca assume sozinha — só habilita a mensagem/CTA.
  const liderPodeTerEncerrado = souSecundaria && pareceExpirada;

  return (
    <AbaLiderContext.Provider
      value={{
        ehLider,
        souSecundaria,
        degradado,
        pronto,
        liderPodeTerEncerrado,
        assumirLideranca,
      }}
    >
      {children}
    </AbaLiderContext.Provider>
  );
}
