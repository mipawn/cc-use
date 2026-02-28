import React from 'react'
import { Button, Result } from 'antd'

type Props = {
  children: React.ReactNode
}

type State = {
  hasError: boolean
  errorMessage: string
}

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
    errorMessage: '',
  }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error('Unhandled renderer error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <Result
          status='error'
          title='页面渲染异常'
          subTitle={this.state.errorMessage || '应用遇到了未处理的异常。'}
          extra={[
            <Button key='reload' type='primary' onClick={() => window.location.reload()}>
              刷新页面
            </Button>,
          ]}
        />
      )
    }

    return this.props.children
  }
}
